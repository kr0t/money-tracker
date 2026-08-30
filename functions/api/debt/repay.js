import {
  DEBT_REPAY,
  addDebt,
  getSummary,
  parseAmountToCents,
  parseJsonBody,
  jsonResponse,
  errorResponse,
} from "../_db.js";

function parseDebtId(raw) {
  if (raw === null || raw === undefined) {
    throw new Error("debt_id is required");
  }
  if (typeof raw === "boolean" || typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new Error("debt_id must be an integer");
  }
  if (raw <= 0) {
    throw new Error("debt_id must be positive");
  }
  return raw;
}

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    const debtId = parseDebtId(data.debt_id);
    const amountCents = parseAmountToCents(data.amount);
    const note = typeof data.note === "string" ? data.note : "";

    const debtTx = await addDebt(context.env.DB, debtId, DEBT_REPAY, amountCents, note);
    const summary = await getSummary(context.env.DB);
    return jsonResponse({ debt_transaction: debtTx, summary }, 201);
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
