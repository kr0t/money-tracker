"""SQLite persistence for the money tracker."""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DB_PATH = DATA_DIR / "ledger.db"

KIND_INCOME = "income"
KIND_EXPENSE = "expense"
DEBT_BORROW = "borrow"
DEBT_REPAY = "repay"


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
                amount INTEGER NOT NULL CHECK (amount > 0),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS debts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS debt_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK (kind IN ('borrow', 'repay')),
                amount INTEGER NOT NULL CHECK (amount > 0),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                linked_tx_id INTEGER REFERENCES transactions(id),
                debt_id INTEGER REFERENCES debts(id)
            )
            """
        )

        debt_tx_cols = _table_columns(conn, "debt_transactions")
        if "debt_id" not in debt_tx_cols:
            conn.execute(
                "ALTER TABLE debt_transactions ADD COLUMN debt_id INTEGER REFERENCES debts(id)"
            )

        orphan_count = conn.execute(
            "SELECT COUNT(*) AS cnt FROM debt_transactions WHERE debt_id IS NULL"
        ).fetchone()["cnt"]
        if orphan_count:
            created_at = _utc_now()
            cur = conn.execute(
                "INSERT INTO debts (name, created_at) VALUES (?, ?)",
                ("Долг", created_at),
            )
            default_id = cur.lastrowid
            conn.execute(
                "UPDATE debt_transactions SET debt_id = ? WHERE debt_id IS NULL",
                (default_id,),
            )

        conn.commit()


def _balance_cents(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(
            CASE kind
                WHEN 'income' THEN amount
                WHEN 'expense' THEN -amount
            END
        ), 0) AS balance
        FROM transactions
        """
    ).fetchone()
    return int(row["balance"])


def _debt_cents(conn: sqlite3.Connection, debt_id: int | None = None) -> int:
    if debt_id is None:
        row = conn.execute(
            """
            SELECT COALESCE(SUM(
                CASE kind
                    WHEN 'borrow' THEN amount
                    WHEN 'repay' THEN -amount
                END
            ), 0) AS debt
            FROM debt_transactions
            """
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT COALESCE(SUM(
                CASE kind
                    WHEN 'borrow' THEN amount
                    WHEN 'repay' THEN -amount
                END
            ), 0) AS debt
            FROM debt_transactions
            WHERE debt_id = ?
            """,
            (debt_id,),
        ).fetchone()
    return int(row["debt"])


def _get_debt_row(conn: sqlite3.Connection, debt_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT id, name, created_at FROM debts WHERE id = ?", (debt_id,)).fetchone()
    if row is None:
        raise ValueError("долг не найден")
    return row


def _serialize_tx(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "amount": row["amount"] / 100,
        "note": row["note"],
        "created_at": row["created_at"],
    }


def _serialize_debt_tx(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "amount": row["amount"] / 100,
        "note": row["note"],
        "created_at": row["created_at"],
        "linked_tx_id": row["linked_tx_id"],
        "debt_id": row["debt_id"],
    }


def _serialize_debt_item(conn: sqlite3.Connection, debt_row: sqlite3.Row, limit: int) -> dict:
    debt_id = debt_row["id"]
    tx_rows = conn.execute(
        """
        SELECT id, kind, amount, note, created_at, linked_tx_id, debt_id
        FROM debt_transactions
        WHERE debt_id = ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (debt_id, limit),
    ).fetchall()
    return {
        "id": debt_id,
        "name": debt_row["name"],
        "balance": _debt_cents(conn, debt_id) / 100,
        "created_at": debt_row["created_at"],
        "transactions": [_serialize_debt_tx(row) for row in tx_rows],
    }


def get_summary(limit: int = 50) -> dict:
    with _connect() as conn:
        balance = _balance_cents(conn)
        debt = _debt_cents(conn)
        rows = conn.execute(
            """
            SELECT id, kind, amount, note, created_at
            FROM transactions
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        debt_rows = conn.execute(
            "SELECT id, name, created_at FROM debts ORDER BY id ASC"
        ).fetchall()
        debts = [_serialize_debt_item(conn, row, limit) for row in debt_rows]

    return {
        "balance": balance / 100,
        "debt": debt / 100,
        "debts": debts,
        "transactions": [_serialize_tx(row) for row in rows],
    }


def add_transaction(kind: str, amount_cents: int, note: str = "") -> dict:
    if kind not in (KIND_INCOME, KIND_EXPENSE):
        raise ValueError("kind must be 'income' or 'expense'")
    if amount_cents <= 0:
        raise ValueError("amount must be positive")

    note = (note or "").strip()
    created_at = _utc_now()

    with _connect() as conn:
        if kind == KIND_EXPENSE:
            balance = _balance_cents(conn)
            if amount_cents > balance:
                raise ValueError("сумма больше доступного баланса")

        cur = conn.execute(
            """
            INSERT INTO transactions (kind, amount, note, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (kind, amount_cents, note, created_at),
        )
        conn.commit()
        tx_id = cur.lastrowid

    return {
        "id": tx_id,
        "kind": kind,
        "amount": amount_cents / 100,
        "note": note,
        "created_at": created_at,
    }


def create_debt(name: str, initial_amount_cents: int = 0) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("укажите название долга")
    if len(name) > 100:
        raise ValueError("название не длиннее 100 символов")
    if initial_amount_cents < 0:
        raise ValueError("amount must be non-negative")

    created_at = _utc_now()

    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO debts (name, created_at) VALUES (?, ?)",
            (name, created_at),
        )
        debt_id = cur.lastrowid
        conn.commit()

    if initial_amount_cents > 0:
        add_debt(debt_id, DEBT_BORROW, initial_amount_cents, "")

    with _connect() as conn:
        debt_row = _get_debt_row(conn, debt_id)
        return _serialize_debt_item(conn, debt_row, 50)


def add_debt(debt_id: int, kind: str, amount_cents: int, note: str = "") -> dict:
    if kind not in (DEBT_BORROW, DEBT_REPAY):
        raise ValueError("kind must be 'borrow' or 'repay'")
    if amount_cents <= 0:
        raise ValueError("amount must be positive")

    note = (note or "").strip()
    created_at = _utc_now()

    with _connect() as conn:
        debt_row = _get_debt_row(conn, debt_id)
        linked_tx_id = None

        if kind == DEBT_REPAY:
            debt_balance = _debt_cents(conn, debt_id)
            if amount_cents > debt_balance:
                raise ValueError("сумма больше текущего долга")

            balance = _balance_cents(conn)
            if amount_cents > balance:
                raise ValueError("сумма больше доступного баланса")

            expense_note = note if note else f"Вернул долг: {debt_row['name']}"
            if note and not note.lower().startswith("вернул"):
                expense_note = f"Вернул долг ({debt_row['name']}): {note}"

            cur_tx = conn.execute(
                """
                INSERT INTO transactions (kind, amount, note, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (KIND_EXPENSE, amount_cents, expense_note, created_at),
            )
            linked_tx_id = cur_tx.lastrowid

        cur = conn.execute(
            """
            INSERT INTO debt_transactions
                (kind, amount, note, created_at, linked_tx_id, debt_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (kind, amount_cents, note, created_at, linked_tx_id, debt_id),
        )
        conn.commit()
        debt_tx_id = cur.lastrowid

    return {
        "id": debt_tx_id,
        "kind": kind,
        "amount": amount_cents / 100,
        "note": note,
        "created_at": created_at,
        "linked_tx_id": linked_tx_id,
        "debt_id": debt_id,
    }


def clear_transactions() -> dict:
    """Remove income/expense history. Available balance becomes 0."""
    with _connect() as conn:
        conn.execute("UPDATE debt_transactions SET linked_tx_id = NULL")
        conn.execute("DELETE FROM transactions")
        conn.commit()
    return get_summary()


def clear_debt_transactions(debt_id: int | None = None) -> dict:
    """Remove debt history. If debt_id is set, remove only that debt item."""
    with _connect() as conn:
        if debt_id is not None:
            _get_debt_row(conn, debt_id)
            linked = conn.execute(
                "SELECT linked_tx_id FROM debt_transactions WHERE debt_id = ? AND linked_tx_id IS NOT NULL",
                (debt_id,),
            ).fetchall()
            for row in linked:
                conn.execute(
                    "UPDATE debt_transactions SET linked_tx_id = NULL WHERE linked_tx_id = ?",
                    (row["linked_tx_id"],),
                )
            conn.execute("DELETE FROM debt_transactions WHERE debt_id = ?", (debt_id,))
            conn.execute("DELETE FROM debts WHERE id = ?", (debt_id,))
        else:
            conn.execute("UPDATE debt_transactions SET linked_tx_id = NULL")
            conn.execute("DELETE FROM debt_transactions")
            conn.execute("DELETE FROM debts")
        conn.commit()
    return get_summary()
