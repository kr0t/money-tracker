import { errorResponse, jsonResponse, parseJsonBody, setTransactionCategory } from "../_db.js";

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    await setTransactionCategory(context.env.DB, data.id, data.category_id ?? null);
    return jsonResponse({ ok: true });
  } catch (err) { return errorResponse(err.message, 400); }
}
