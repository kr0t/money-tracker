// Shared database logic for Cloudflare D1

export const KIND_INCOME = "income";
export const KIND_EXPENSE = "expense";
export const DEBT_BORROW = "borrow";
export const DEBT_REPAY = "repay";

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

export function parseAmountToCents(raw) {
  if (raw === null || raw === undefined) {
    throw new Error("amount is required");
  }
  if (typeof raw === "boolean") {
    throw new Error("amount must be a number");
  }
  let text = "";
  if (typeof raw === "number") {
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw.trim().replace(",", ".");
  } else {
    throw new Error("amount must be a number");
  }

  if (!AMOUNT_RE.test(text)) {
    throw new Error("amount must be a positive number with at most 2 decimals");
  }

  const [intStr, fracStr = ""] = text.split(".");
  const intPart = parseInt(intStr, 10);
  const fracPart = parseInt(fracStr.padEnd(2, "0").slice(0, 2), 10);
  const cents = intPart * 100 + fracPart;

  if (cents <= 0) {
    throw new Error("amount must be positive");
  }

  return cents;
}

export async function parseJsonBody(request) {
  try {
    const text = await request.text();
    if (!text || !text.trim()) {
      return {};
    }
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("JSON body must be an object");
    }
    return data;
  } catch (err) {
    if (err.message === "JSON body must be an object") throw err;
    throw new Error("invalid JSON body");
  }
}

let schemaInitialized = false;

export async function ensureSchema(db) {
  if (schemaInitialized) return;
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS debts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS debt_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('borrow', 'repay')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        linked_tx_id INTEGER REFERENCES transactions(id),
        debt_id INTEGER REFERENCES debts(id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS processed_requests (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `),
  ]);
  schemaInitialized = true;
}

export function utcNow() {
  return new Date().toISOString();
}

export async function getBalanceCents(db) {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE kind
           WHEN 'income' THEN amount
           WHEN 'expense' THEN -amount
         END
       ), 0) AS balance FROM transactions`
    )
    .first();
  return row ? Number(row.balance) : 0;
}

export async function getDebtCents(db, debtId = null) {
  if (debtId === null) {
    const row = await db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE kind
             WHEN 'borrow' THEN amount
             WHEN 'repay' THEN -amount
           END
         ), 0) AS debt FROM debt_transactions`
      )
      .first();
    return row ? Number(row.debt) : 0;
  }
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE kind
           WHEN 'borrow' THEN amount
           WHEN 'repay' THEN -amount
         END
       ), 0) AS debt FROM debt_transactions WHERE debt_id = ?`
    )
    .bind(debtId)
    .first();
  return row ? Number(row.debt) : 0;
}

export async function getDebtRow(db, debtId) {
  const row = await db
    .prepare("SELECT id, name, created_at FROM debts WHERE id = ?")
    .bind(debtId)
    .first();
  if (!row) {
    throw new Error("долг не найден");
  }
  return row;
}

function serializeTx(row) {
  return {
    id: row.id,
    kind: row.kind,
    amount: row.amount / 100,
    note: row.note,
    created_at: row.created_at,
    linked_to_debt: Boolean(row.linked_to_debt),
  };
}

function serializeDebtTx(row) {
  return {
    id: row.id,
    kind: row.kind,
    amount: row.amount / 100,
    note: row.note,
    created_at: row.created_at,
    linked_tx_id: row.linked_tx_id,
    debt_id: row.debt_id,
  };
}

export async function getSummary(db, limit = 50) {
  await ensureSchema(db);
  const balanceCents = await getBalanceCents(db);
  const totalDebtCents = await getDebtCents(db);

  const { results: txRows } = await db
    .prepare(
      `SELECT t.id, t.kind, t.amount, t.note, t.created_at,
              EXISTS(
                SELECT 1 FROM debt_transactions d WHERE d.linked_tx_id = t.id
              ) AS linked_to_debt
       FROM transactions t
       ORDER BY t.id DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  const { results: debtRows } = await db
    .prepare("SELECT id, name, created_at FROM debts ORDER BY id ASC")
    .all();

  const debts = [];
  for (const row of debtRows) {
    const debtBalance = await getDebtCents(db, row.id);
    const { results: debtTxRows } = await db
      .prepare(
        `SELECT id, kind, amount, note, created_at, linked_tx_id, debt_id
         FROM debt_transactions
         WHERE debt_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .bind(row.id, limit)
      .all();

    debts.push({
      id: row.id,
      name: row.name,
      balance: debtBalance / 100,
      created_at: row.created_at,
      transactions: debtTxRows.map(serializeDebtTx),
    });
  }

  return {
    balance: balanceCents / 100,
    debt: totalDebtCents / 100,
    debts,
    transactions: (txRows || []).map(serializeTx),
  };
}

export async function addTransaction(db, kind, amountCents, note = "", requestId = null) {
  await ensureSchema(db);
  if (kind !== KIND_INCOME && kind !== KIND_EXPENSE) {
    throw new Error("kind must be 'income' or 'expense'");
  }
  if (amountCents <= 0) {
    throw new Error("amount must be positive");
  }

  const cleanRequestId =
    typeof requestId === "string" && requestId.trim() ? requestId.trim().slice(0, 80) : null;
  const cleanNote = (note || "").trim();
  const createdAt = utcNow();

  if (kind === KIND_EXPENSE) {
    const balance = await getBalanceCents(db);
    if (amountCents > balance) {
      throw new Error("сумма больше доступного баланса");
    }
  }

  if (cleanRequestId) {
    const reserved = await db
      .prepare(
        "INSERT OR IGNORE INTO processed_requests (request_id, created_at) VALUES (?, ?)"
      )
      .bind(cleanRequestId, createdAt)
      .run();
    if (!reserved.meta?.changes) {
      return { duplicate: true, transaction: null };
    }
  }

  const result = await db
    .prepare(
      `INSERT INTO transactions (kind, amount, note, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(kind, amountCents, cleanNote, createdAt)
    .run();

  const txId = result.meta?.last_row_id;

  return {
    duplicate: false,
    transaction: {
      id: txId,
      kind,
      amount: amountCents / 100,
      note: cleanNote,
      created_at: createdAt,
    },
  };
}

export async function createDebt(db, name, initialAmountCents = 0) {
  await ensureSchema(db);
  const cleanName = (name || "").trim();
  if (!cleanName) {
    throw new Error("укажите название долга");
  }
  if (cleanName.length > 100) {
    throw new Error("название не длиннее 100 символов");
  }
  if (initialAmountCents < 0) {
    throw new Error("amount must be non-negative");
  }

  const createdAt = utcNow();
  const result = await db
    .prepare("INSERT INTO debts (name, created_at) VALUES (?, ?)")
    .bind(cleanName, createdAt)
    .run();

  const debtId = result.meta?.last_row_id;

  if (initialAmountCents > 0) {
    await addDebt(db, debtId, DEBT_BORROW, initialAmountCents, "");
  }

  const debtRow = await getDebtRow(db, debtId);
  const debtBalance = await getDebtCents(db, debtId);
  const { results: txRows } = await db
    .prepare(
      `SELECT id, kind, amount, note, created_at, linked_tx_id, debt_id
       FROM debt_transactions
       WHERE debt_id = ?
       ORDER BY id DESC
       LIMIT 50`
    )
    .bind(debtId)
    .all();

  return {
    id: debtId,
    name: debtRow.name,
    balance: debtBalance / 100,
    created_at: debtRow.created_at,
    transactions: (txRows || []).map(serializeDebtTx),
  };
}

export async function addDebt(db, debtId, kind, amountCents, note = "") {
  await ensureSchema(db);
  if (kind !== DEBT_BORROW && kind !== DEBT_REPAY) {
    throw new Error("kind must be 'borrow' or 'repay'");
  }
  if (amountCents <= 0) {
    throw new Error("amount must be positive");
  }

  const cleanNote = (note || "").trim();
  const createdAt = utcNow();
  const debtRow = await getDebtRow(db, debtId);

  let linkedTxId = null;

  if (kind === DEBT_REPAY) {
    const debtBalance = await getDebtCents(db, debtId);
    if (amountCents > debtBalance) {
      throw new Error("сумма больше текущего долга");
    }

    const availableBalance = await getBalanceCents(db);
    if (amountCents > availableBalance) {
      throw new Error("сумма больше доступного баланса");
    }

    let expenseNote = cleanNote ? `Вернул долг: ${cleanNote}` : `Вернул долг: ${debtRow.name}`;
    if (cleanNote && !cleanNote.toLowerCase().startsWith("вернул")) {
      expenseNote = `Вернул долг (${debtRow.name}): ${cleanNote}`;
    }

    const txResult = await db
      .prepare(
        `INSERT INTO transactions (kind, amount, note, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(KIND_EXPENSE, amountCents, expenseNote, createdAt)
      .run();
    linkedTxId = txResult.meta?.last_row_id;
  }

  const result = await db
    .prepare(
      `INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(kind, amountCents, cleanNote, createdAt, linkedTxId, debtId)
    .run();

  const debtTxId = result.meta?.last_row_id;

  return {
    id: debtTxId,
    kind,
    amount: amountCents / 100,
    note: cleanNote,
    created_at: createdAt,
    linked_tx_id: linkedTxId,
    debt_id: debtId,
  };
}

export async function deleteTransaction(db, txId) {
  await ensureSchema(db);
  const id = Number(txId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("некорректный id операции");
  }

  const row = await db
    .prepare(
      `SELECT id, kind, amount, note, created_at
       FROM transactions
       WHERE id = ?`
    )
    .bind(id)
    .first();

  if (!row) {
    throw new Error("операция не найдена");
  }

  const linkedDebtTx = await db
    .prepare(
      `SELECT id FROM debt_transactions WHERE linked_tx_id = ?`
    )
    .bind(id)
    .first();

  if (linkedDebtTx) {
    await db.batch([
      db.prepare("DELETE FROM debt_transactions WHERE id = ?").bind(linkedDebtTx.id),
      db.prepare("DELETE FROM transactions WHERE id = ?").bind(id),
    ]);
  } else {
    await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();
  }

  return getSummary(db);
}

export async function clearTransactions(db) {
  await ensureSchema(db);
  await db.batch([
    db.prepare("UPDATE debt_transactions SET linked_tx_id = NULL"),
    db.prepare("DELETE FROM transactions"),
  ]);
  return getSummary(db);
}

export async function clearDebtTransactions(db, debtId = null) {
  await ensureSchema(db);
  if (debtId !== null) {
    await getDebtRow(db, debtId);
    await db.batch([
      db.prepare("UPDATE debt_transactions SET linked_tx_id = NULL WHERE debt_id = ?").bind(debtId),
      db.prepare("DELETE FROM debt_transactions WHERE debt_id = ?").bind(debtId),
      db.prepare("DELETE FROM debts WHERE id = ?").bind(debtId),
    ]);
  } else {
    await db.batch([
      db.prepare("UPDATE debt_transactions SET linked_tx_id = NULL"),
      db.prepare("DELETE FROM debt_transactions"),
      db.prepare("DELETE FROM debts"),
    ]);
  }
  return getSummary(db);
}
