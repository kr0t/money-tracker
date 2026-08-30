import {
  clearDebtTransactions,
  parseJsonBody,
  jsonResponse,
  errorResponse,
} from "../_db.js";

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    let debtId = null;
    if (data.debt_id !== null && data.debt_id !== undefined) {
      if (
        typeof data.debt_id === "boolean" ||
        typeof data.debt_id !== "number" ||
        !Number.isInteger(data.debt_id)
      ) {
        throw new Error("debt_id must be an integer");
      }
      if (data.debt_id <= 0) {
        throw new Error("debt_id must be positive");
      }
      debtId = data.debt_id;
    }

    const summary = await clearDebtTransactions(context.env.DB, debtId);
    return jsonResponse({ summary });
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
