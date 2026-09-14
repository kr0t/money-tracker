"""SQLite persistence for the money tracker."""

from __future__ import annotations

import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
DB_PATH = DATA_DIR / "ledger.db"

KIND_INCOME = "income"
KIND_EXPENSE = "expense"
DEBT_BORROW = "borrow"
DEBT_REPAY = "repay"

BALANCE_CENTS_EXPR = """
COALESCE(SUM(CASE kind
    WHEN 'income' THEN amount
    WHEN 'expense' THEN -amount
END), 0)"""

DEBT_CENTS_EXPR = """
COALESCE(SUM(CASE kind
    WHEN 'borrow' THEN amount
    WHEN 'repay' THEN -amount
END), 0)"""

PROCESSED_REQUESTS_RETENTION = timedelta(hours=24)


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def _connection():
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def _transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    else:
        conn.execute("COMMIT")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def init_db() -> None:
    with _connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
                amount INTEGER NOT NULL CHECK (amount > 0),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                category_id INTEGER REFERENCES categories(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS processed_requests (
                request_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            )
            """
        )

        debt_tx_cols = _table_columns(conn, "debt_transactions")
        if "debt_id" not in debt_tx_cols:
            conn.execute(
                "ALTER TABLE debt_transactions ADD COLUMN debt_id INTEGER REFERENCES debts(id)"
            )
        if "category_id" not in _table_columns(conn, "transactions"):
            conn.execute("ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id)")

        orphan_count = conn.execute(
            "SELECT COUNT(*) AS cnt FROM debt_transactions WHERE debt_id IS NULL"
        ).fetchone()["cnt"]
        if orphan_count:
            with _transaction(conn):
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


def _balance_cents(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        f"SELECT {BALANCE_CENTS_EXPR} AS balance FROM transactions"
    ).fetchone()
    return int(row["balance"])


def _debt_cents(conn: sqlite3.Connection, debt_id: int | None = None) -> int:
    if debt_id is None:
        row = conn.execute(
            f"SELECT {DEBT_CENTS_EXPR} AS debt FROM debt_transactions"
        ).fetchone()
    else:
        row = conn.execute(
            f"SELECT {DEBT_CENTS_EXPR} AS debt FROM debt_transactions WHERE debt_id = ?",
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
        "linked_to_debt": bool(row["linked_to_debt"]),
        "category_id": row["category_id"],
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
    with _connection() as conn:
        balance = _balance_cents(conn)
        debt = _debt_cents(conn)
        rows = conn.execute(
            """
            SELECT t.id, t.kind, t.amount, t.note, t.created_at, t.category_id,
                   EXISTS(
                       SELECT 1 FROM debt_transactions d WHERE d.linked_tx_id = t.id
                   ) AS linked_to_debt
            FROM transactions t
            ORDER BY t.id DESC
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


def _category(conn: sqlite3.Connection, category_id: int, include_archived: bool = False) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
    if row is None or (row["is_archived"] and not include_archived):
        raise ValueError("категория не найдена или архивирована")
    return row


def _category_data(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "is_archived": bool(row["is_archived"]), "created_at": row["created_at"]}


def list_categories() -> list[dict]:
    with _connection() as conn:
        rows = conn.execute("SELECT * FROM categories ORDER BY is_archived, name COLLATE NOCASE").fetchall()
    return [_category_data(row) for row in rows]


def create_category(name: str) -> dict:
    clean_name = name.strip() if isinstance(name, str) else ""
    if not clean_name or len(clean_name) > 50:
        raise ValueError("название категории должно содержать от 1 до 50 символов")
    with _connection() as conn:
        try:
            cur = conn.execute("INSERT INTO categories (name, created_at) VALUES (?, ?)", (clean_name, _utc_now()))
        except sqlite3.IntegrityError as exc:
            raise ValueError("такая категория уже существует") from exc
        return _category_data(_category(conn, cur.lastrowid, True))


def update_category(category_id: int, name=None, archived=None) -> dict:
    if isinstance(category_id, bool) or not isinstance(category_id, int) or category_id <= 0:
        raise ValueError("некорректный id категории")
    if name is None and archived is None:
        raise ValueError("укажите изменения категории")
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name.strip()) > 50):
        raise ValueError("название категории должно содержать от 1 до 50 символов")
    if archived is not None and not isinstance(archived, bool):
        raise ValueError("archived must be a boolean")
    with _connection() as conn:
        _category(conn, category_id, True)
        try:
            if name is not None:
                conn.execute("UPDATE categories SET name = ? WHERE id = ?", (name.strip(), category_id))
            if archived is not None:
                conn.execute("UPDATE categories SET is_archived = ? WHERE id = ?", (int(archived), category_id))
        except sqlite3.IntegrityError as exc:
            raise ValueError("такая категория уже существует") from exc
        return _category_data(_category(conn, category_id, True))


def add_transaction(kind: str, amount_cents: int, note: str = "", request_id: str | None = None, category_id=None) -> dict:
    if kind not in (KIND_INCOME, KIND_EXPENSE):
        raise ValueError("kind must be 'income' or 'expense'")
    if amount_cents <= 0:
        raise ValueError("amount must be positive")

    note = (note or "").strip()
    clean_request_id = (
        request_id.strip()[:80]
        if isinstance(request_id, str) and request_id.strip()
        else None
    )
    created_at = _utc_now()
    if category_id is not None and (kind != KIND_EXPENSE or isinstance(category_id, bool) or not isinstance(category_id, int) or category_id <= 0):
        raise ValueError("категорию можно назначить только обычной трате")

    with _connection() as conn:
        with _transaction(conn):
            if category_id is not None:
                _category(conn, category_id)
            if clean_request_id:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO processed_requests (request_id, created_at) VALUES (?, ?)",
                    (clean_request_id, created_at),
                )
                cutoff = (datetime.now(timezone.utc) - PROCESSED_REQUESTS_RETENTION).isoformat()
                conn.execute("DELETE FROM processed_requests WHERE created_at < ?", (cutoff,))
                if cur.rowcount != 1:
                    return {"duplicate": True, "transaction": None}

            if kind == KIND_EXPENSE:
                cur = conn.execute(
                    f"""
                    INSERT INTO transactions (kind, amount, note, created_at, category_id)
                    SELECT 'expense', ?, ?, ?, ?
                    WHERE ? <= (SELECT {BALANCE_CENTS_EXPR} FROM transactions)
                    """,
                    (amount_cents, note, created_at, category_id, amount_cents),
                )
                if cur.rowcount != 1:
                    raise ValueError("сумма больше доступного баланса")
                tx_id = cur.lastrowid
            else:
                cur = conn.execute(
                    """
                    INSERT INTO transactions (kind, amount, note, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (kind, amount_cents, note, created_at),
                )
                tx_id = cur.lastrowid

    return {
        "duplicate": False,
        "transaction": {
            "id": tx_id,
            "kind": kind,
            "amount": amount_cents / 100,
            "note": note,
            "created_at": created_at,
            "category_id": category_id,
        },
    }


def set_transaction_category(tx_id: int, category_id) -> None:
    if isinstance(tx_id, bool) or not isinstance(tx_id, int) or tx_id <= 0:
        raise ValueError("некорректный id операции")
    if category_id is not None and (isinstance(category_id, bool) or not isinstance(category_id, int) or category_id <= 0):
        raise ValueError("некорректный id категории")
    with _connection() as conn:
        with _transaction(conn):
            tx = conn.execute("SELECT kind FROM transactions WHERE id = ?", (tx_id,)).fetchone()
            linked = conn.execute("SELECT 1 FROM debt_transactions WHERE linked_tx_id = ?", (tx_id,)).fetchone()
            if tx is None:
                raise ValueError("операция не найдена")
            if tx["kind"] != KIND_EXPENSE or linked:
                raise ValueError("категорию можно назначить только обычной трате")
            if category_id is not None:
                _category(conn, category_id)
            conn.execute("UPDATE transactions SET category_id = ? WHERE id = ?", (category_id, tx_id))


def get_analytics(month: str) -> dict:
    if not isinstance(month, str) or not re.fullmatch(r"\d{4}-\d{2}", month):
        raise ValueError("month must use YYYY-MM")
    try:
        start = datetime.strptime(month, "%Y-%m").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError("month must use YYYY-MM") from exc
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    with _connection() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.amount, t.note, t.created_at, t.category_id, c.name AS category_name,
                   EXISTS(SELECT 1 FROM debt_transactions d WHERE d.linked_tx_id = t.id) AS linked_to_debt
            FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
            WHERE t.kind = 'expense' AND t.created_at >= ? AND t.created_at < ? ORDER BY t.id DESC
            """, (start.isoformat(), end.isoformat())
        ).fetchall()
    grouped = {}
    transactions = []
    for row in rows:
        if row["linked_to_debt"]:
            key, name, system = "debt", "Возврат долга", True
        elif row["category_id"] is None:
            key, name, system = "uncategorized", "Без категории", False
        else:
            key, name, system = f"category:{row['category_id']}", row["category_name"], False
        grouped[key] = grouped.get(key, {"id": row["category_id"], "key": key, "name": name, "cents": 0, "system": system})
        grouped[key]["cents"] += row["amount"]
        transactions.append({"id": row["id"], "amount": row["amount"] / 100, "note": row["note"], "created_at": row["created_at"], "category_id": row["category_id"], "category_name": name, "system_category": system})
    total = sum(item["cents"] for item in grouped.values())
    categories = [{"id": item["id"], "key": item["key"], "name": item["name"], "amount": item["cents"] / 100, "share": item["cents"] / total if total else 0, "system": item["system"]} for item in grouped.values()]
    categories.sort(key=lambda item: item["amount"], reverse=True)
    return {"month": month, "total": total / 100, "categories": categories, "transactions": transactions}


def delete_transaction(tx_id) -> dict:
    if isinstance(tx_id, bool) or not isinstance(tx_id, int) or tx_id <= 0:
        raise ValueError("некорректный id операции")

    with _connection() as conn:
        with _transaction(conn):
            conn.execute("DELETE FROM debt_transactions WHERE linked_tx_id = ?", (tx_id,))
            cur = conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,))
            if cur.rowcount != 1:
                raise ValueError("операция не найдена")

    return get_summary()


def create_debt(name: str, initial_amount_cents: int = 0) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("укажите название долга")
    if len(name) > 100:
        raise ValueError("название не длиннее 100 символов")
    if initial_amount_cents < 0:
        raise ValueError("amount must be non-negative")

    created_at = _utc_now()

    with _connection() as conn:
        with _transaction(conn):
            cur = conn.execute(
                "INSERT INTO debts (name, created_at) VALUES (?, ?)",
                (name, created_at),
            )
            debt_id = cur.lastrowid

            if initial_amount_cents > 0:
                conn.execute(
                    """
                    INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
                    VALUES (?, ?, ?, ?, NULL, ?)
                    """,
                    (DEBT_BORROW, initial_amount_cents, "", created_at, debt_id),
                )

        debt_row = _get_debt_row(conn, debt_id)
        return _serialize_debt_item(conn, debt_row, 50)


def add_debt(debt_id: int, kind: str, amount_cents: int, note: str = "") -> dict:
    if kind not in (DEBT_BORROW, DEBT_REPAY):
        raise ValueError("kind must be 'borrow' or 'repay'")
    if amount_cents <= 0:
        raise ValueError("amount must be positive")

    note = (note or "").strip()
    created_at = _utc_now()

    with _connection() as conn:
        with _transaction(conn):
            debt_row = _get_debt_row(conn, debt_id)

            if kind == DEBT_BORROW:
                cur = conn.execute(
                    """
                    INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
                    VALUES (?, ?, ?, ?, NULL, ?)
                    """,
                    (kind, amount_cents, note, created_at, debt_id),
                )
                debt_tx_id = cur.lastrowid
                linked_tx_id = None
            else:
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
                    INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (kind, amount_cents, note, created_at, linked_tx_id, debt_id),
                )
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
    with _connection() as conn:
        with _transaction(conn):
            conn.execute("UPDATE debt_transactions SET linked_tx_id = NULL")
            conn.execute("DELETE FROM transactions")
    return get_summary()


def clear_debt_transactions(debt_id: int | None = None) -> dict:
    """Remove debt history. If debt_id is set, remove only that debt item."""
    with _connection() as conn:
        with _transaction(conn):
            if debt_id is not None:
                _get_debt_row(conn, debt_id)
                conn.execute(
                    """
                    UPDATE debt_transactions SET linked_tx_id = NULL
                    WHERE debt_id = ? AND linked_tx_id IS NOT NULL
                    """,
                    (debt_id,),
                )
                conn.execute("DELETE FROM debt_transactions WHERE debt_id = ?", (debt_id,))
                conn.execute("DELETE FROM debts WHERE id = ?", (debt_id,))
            else:
                conn.execute("UPDATE debt_transactions SET linked_tx_id = NULL")
                conn.execute("DELETE FROM debt_transactions")
                conn.execute("DELETE FROM debts")
    return get_summary()
