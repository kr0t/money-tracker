// Shared database logic for Cloudflare D1

export const KIND_INCOME = "income";
export const KIND_EXPENSE = "expense";
export const DEBT_BORROW = "borrow";
export const DEBT_REPAY = "repay";

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

const BALANCE_CENTS_EXPR = `COALESCE(SUM(
  CASE kind
    WHEN 'income' THEN amount
    WHEN 'expense' THEN -amount
  END
), 0)`;

const DEBT_CENTS_EXPR = `COALESCE(SUM(
  CASE kind
    WHEN 'borrow' THEN amount
    WHEN 'repay' THEN -amount
  END
), 0)`;

const PROCESSED_REQUESTS_RETENTION_MS = 24 * 60 * 60 * 1000;

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
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
        created_at TEXT NOT NULL,
        category_id INTEGER REFERENCES categories(id)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
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
    db.prepare(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        fail_count INTEGER NOT NULL
      )
    `),
  ]);
  const columns = await db.prepare("PRAGMA table_info(transactions)").all();
  if (!(columns.results || []).some((column) => column.name === "category_id")) {
    await db.prepare("ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id)").run();
  }
  schemaInitialized = true;
}

export function utcNow() {
  return new Date().toISOString();
}

export async function getBalanceCents(db) {
  const row = await db
    .prepare(`SELECT ${BALANCE_CENTS_EXPR} AS balance FROM transactions`)
    .first();
  return row ? Number(row.balance) : 0;
}

export async function getDebtCents(db, debtId = null) {
  if (debtId === null) {
    const row = await db
      .prepare(`SELECT ${DEBT_CENTS_EXPR} AS debt FROM debt_transactions`)
      .first();
    return row ? Number(row.debt) : 0;
  }
  const row = await db
    .prepare(`SELECT ${DEBT_CENTS_EXPR} AS debt FROM debt_transactions WHERE debt_id = ?`)
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
    category_id: row.category_id,
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
      `SELECT t.id, t.kind, t.amount, t.note, t.created_at, t.category_id,
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

function categoryData(row) {
  return { id: row.id, name: row.name, is_archived: Boolean(row.is_archived), created_at: row.created_at };
}

export async function listCategories(db) {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT * FROM categories ORDER BY is_archived, name COLLATE NOCASE").all();
  return (results || []).map(categoryData);
}

export async function createCategory(db, name) {
  await ensureSchema(db);
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName || cleanName.length > 50) throw new Error("название категории должно содержать от 1 до 50 символов");
  try {
    const result = await db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?)").bind(cleanName, utcNow()).run();
    const row = await db.prepare("SELECT * FROM categories WHERE id = ?").bind(result.meta.last_row_id).first();
    return categoryData(row);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new Error("такая категория уже существует");
    throw err;
  }
}

export async function updateCategory(db, id, name, archived) {
  await ensureSchema(db);
  if (!Number.isInteger(id) || id <= 0) throw new Error("некорректный id категории");
  if (name === undefined && archived === undefined) throw new Error("укажите изменения категории");
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.trim().length > 50)) throw new Error("название категории должно содержать от 1 до 50 символов");
  if (archived !== undefined && typeof archived !== "boolean") throw new Error("archived must be a boolean");
  const existing = await db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first();
  if (!existing) throw new Error("категория не найдена или архивирована");
  try {
    if (name !== undefined) await db.prepare("UPDATE categories SET name = ? WHERE id = ?").bind(name.trim(), id).run();
    if (archived !== undefined) await db.prepare("UPDATE categories SET is_archived = ? WHERE id = ?").bind(archived ? 1 : 0, id).run();
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new Error("такая категория уже существует");
    throw err;
  }
  return categoryData(await db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first());
}

async function requireActiveCategory(db, categoryId) {
  const row = await db.prepare("SELECT * FROM categories WHERE id = ? AND is_archived = 0").bind(categoryId).first();
  if (!row) throw new Error("категория не найдена или архивирована");
}

export async function setTransactionCategory(db, id, categoryId) {
  await ensureSchema(db);
  if (!Number.isInteger(id) || id <= 0 || (categoryId !== null && (!Number.isInteger(categoryId) || categoryId <= 0))) throw new Error("некорректный id категории или операции");
  const tx = await db.prepare("SELECT kind FROM transactions WHERE id = ?").bind(id).first();
  const linked = await db.prepare("SELECT 1 FROM debt_transactions WHERE linked_tx_id = ?").bind(id).first();
  if (!tx) throw new Error("операция не найдена");
  if (tx.kind !== KIND_EXPENSE || linked) throw new Error("категорию можно назначить только обычной трате");
  if (categoryId !== null) await requireActiveCategory(db, categoryId);
  await db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").bind(categoryId, id).run();
}

export async function getAnalytics(db, month) {
  await ensureSchema(db);
  if (!/^\d{4}-\d{2}$/.test(month || "")) throw new Error("month must use YYYY-MM");
  const start = `${month}-01T00:00:00.000Z`;
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime()) || startDate.getUTCMonth() + 1 !== Number(month.slice(5))) throw new Error("month must use YYYY-MM");
  const end = startDate.getUTCMonth() === 11 ? `${Number(month.slice(0, 4)) + 1}-01-01T00:00:00.000Z` : `${month.slice(0, 5)}${String(Number(month.slice(5)) + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  const { results } = await db.prepare(`SELECT t.id, t.amount, t.note, t.created_at, t.category_id, c.name AS category_name, EXISTS(SELECT 1 FROM debt_transactions d WHERE d.linked_tx_id = t.id) AS linked_to_debt FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.kind = 'expense' AND t.created_at >= ? AND t.created_at < ? ORDER BY t.id DESC`).bind(start, end).all();
  const grouped = new Map(); const transactions = [];
  for (const row of results || []) {
    const system = Boolean(row.linked_to_debt); const key = system ? "debt" : row.category_id === null ? "uncategorized" : `category:${row.category_id}`; const name = system ? "Возврат долга" : row.category_id === null ? "Без категории" : row.category_name;
    const group = grouped.get(key) || { id: row.category_id, key, name, cents: 0, system }; group.cents += row.amount; grouped.set(key, group);
    transactions.push({ id: row.id, amount: row.amount / 100, note: row.note, created_at: row.created_at, category_id: row.category_id, category_name: name, system_category: system });
  }
  const total = [...grouped.values()].reduce((sum, item) => sum + item.cents, 0);
  const categories = [...grouped.values()].map((item) => ({ id: item.id, key: item.key, name: item.name, amount: item.cents / 100, share: total ? item.cents / total : 0, system: item.system })).sort((a, b) => b.amount - a.amount);
  return { month, total: total / 100, categories, transactions };
}

export async function addTransaction(db, kind, amountCents, note = "", requestId = null, categoryId = null) {
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
  if (categoryId !== null && (kind !== KIND_EXPENSE || !Number.isInteger(categoryId) || categoryId <= 0)) throw new Error("категорию можно назначить только обычной трате");
  if (categoryId !== null) await requireActiveCategory(db, categoryId);

  if (cleanRequestId) {
    const reserved = await db
      .prepare(
        "INSERT OR IGNORE INTO processed_requests (request_id, created_at) VALUES (?, ?)"
      )
      .bind(cleanRequestId, createdAt)
      .run();
    await db
      .prepare("DELETE FROM processed_requests WHERE created_at < ?")
      .bind(new Date(Date.now() - PROCESSED_REQUESTS_RETENTION_MS).toISOString())
      .run();
    if (!reserved.meta?.changes) {
      return { duplicate: true, transaction: null };
    }
  }

  let result;
  if (kind === KIND_EXPENSE) {
    result = await db
      .prepare(
        `INSERT INTO transactions (kind, amount, note, created_at, category_id)
         SELECT 'expense', ?, ?, ?, ?
         WHERE ? <= (SELECT ${BALANCE_CENTS_EXPR} FROM transactions)`
      )
      .bind(amountCents, cleanNote, createdAt, categoryId, amountCents)
      .run();

    if (!result.meta?.changes) {
      if (cleanRequestId) {
        await db
          .prepare("DELETE FROM processed_requests WHERE request_id = ?")
          .bind(cleanRequestId)
          .run();
      }
      throw new Error("сумма больше доступного баланса");
    }
  } else {
    result = await db
      .prepare(
        `INSERT INTO transactions (kind, amount, note, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(kind, amountCents, cleanNote, createdAt)
      .run();
  }

  const txId = result.meta?.last_row_id;

  return {
    duplicate: false,
    transaction: {
      id: txId,
      kind,
      amount: amountCents / 100,
      note: cleanNote,
      created_at: createdAt,
      category_id: categoryId,
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

  const statements = [
    db.prepare("INSERT INTO debts (name, created_at) VALUES (?, ?)").bind(cleanName, createdAt),
  ];
  if (initialAmountCents > 0) {
    statements.push(
      db.prepare(
        `INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
         SELECT 'borrow', ?, ?, ?, NULL, (SELECT MAX(id) FROM debts)`
      ).bind(initialAmountCents, "", createdAt)
    );
  }
  const results = await db.batch(statements);

  const debtId = results[0].meta?.last_row_id;

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

  if (kind === DEBT_BORROW) {
    const result = await db
      .prepare(
        `INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
         SELECT 'borrow', ?, ?, ?, NULL, ?
         WHERE EXISTS (SELECT 1 FROM debts WHERE id = ?)`
      )
      .bind(amountCents, cleanNote, createdAt, debtId, debtId)
      .run();

    if (!result.meta?.changes) {
      throw new Error("долг не найден");
    }

    return {
      id: result.meta?.last_row_id,
      kind,
      amount: amountCents / 100,
      note: cleanNote,
      created_at: createdAt,
      linked_tx_id: null,
      debt_id: debtId,
    };
  }

  let expenseNote = cleanNote ? `Вернул долг: ${cleanNote}` : `Вернул долг: ${debtRow.name}`;
  if (cleanNote && !cleanNote.toLowerCase().startsWith("вернул")) {
    expenseNote = `Вернул долг (${debtRow.name}): ${cleanNote}`;
  }

  const insertTx = await db
    .prepare(
      `INSERT INTO transactions (kind, amount, note, created_at)
       SELECT 'expense', ?, ?, ?
       WHERE ? <= (SELECT ${BALANCE_CENTS_EXPR} FROM transactions)
         AND ? <= (SELECT ${DEBT_CENTS_EXPR} FROM debt_transactions WHERE debt_id = ?)
         AND EXISTS (SELECT 1 FROM debts WHERE id = ?)`
    )
    .bind(amountCents, expenseNote, createdAt, amountCents, amountCents, debtId, debtId)
    .run();

  if (!insertTx.meta?.changes) {
    await getDebtRow(db, debtId);
    const debtBalance = await getDebtCents(db, debtId);
    if (amountCents > debtBalance) {
      throw new Error("сумма больше текущего долга");
    }
    throw new Error("сумма больше доступного баланса");
  }

  const txId = insertTx.meta?.last_row_id;

  let debtTxId;
  try {
    const result = await db
      .prepare(
        `INSERT INTO debt_transactions (kind, amount, note, created_at, linked_tx_id, debt_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(kind, amountCents, cleanNote, createdAt, txId, debtId)
      .run();
    debtTxId = result.meta?.last_row_id;
  } catch (err) {
    await db
      .prepare(
        `DELETE FROM transactions WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM debt_transactions WHERE linked_tx_id = ?
         )`
      )
      .bind(txId, txId)
      .run();
    throw err;
  }

  return {
    id: debtTxId,
    kind,
    amount: amountCents / 100,
    note: cleanNote,
    created_at: createdAt,
    linked_tx_id: txId,
    debt_id: debtId,
  };
}

export async function deleteTransaction(db, txId) {
  await ensureSchema(db);
  const id = Number(txId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("некорректный id операции");
  }

  const results = await db.batch([
    db.prepare("DELETE FROM debt_transactions WHERE linked_tx_id = ?").bind(id),
    db.prepare("DELETE FROM transactions WHERE id = ?").bind(id),
  ]);

  if (!results[1].meta?.changes) {
    throw new Error("операция не найдена");
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
