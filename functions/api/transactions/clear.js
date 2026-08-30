import {
  clearTransactions,
  jsonResponse,
  errorResponse,
} from "../_db.js";

export async function onRequestPost(context) {
  try {
    const summary = await clearTransactions(context.env.DB);
    return jsonResponse({ summary });
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}
