import {
  KIND_EXPENSE,
  addTransaction,
  getSummary,
  parseAmountToCents,
  parseJsonBody,
  jsonResponse,
  errorResponse,
} from "./_db.js";

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    const amountCents = parseAmountToCents(data.amount);
    const note = typeof data.note === "string" ? data.note : "";
    const tx = await addTransaction(context.env.DB, KIND_EXPENSE, amountCents, note);
    const summary = await getSummary(context.env.DB);
    return jsonResponse({ transaction: tx, summary }, 201);
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
