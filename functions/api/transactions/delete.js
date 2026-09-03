import {
  deleteTransaction,
  parseJsonBody,
  jsonResponse,
  errorResponse,
} from "../_db.js";

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    const summary = await deleteTransaction(context.env.DB, data.id);
    return jsonResponse({ summary });
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
