import {
  KIND_INCOME,
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
    const requestId = typeof data.request_id === "string" ? data.request_id : null;
    const result = await addTransaction(
      context.env.DB,
      KIND_INCOME,
      amountCents,
      note,
      requestId
    );
    const summary = await getSummary(context.env.DB);
    return jsonResponse(
      { transaction: result.transaction, summary, duplicate: result.duplicate },
      result.duplicate ? 200 : 201
    );
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
