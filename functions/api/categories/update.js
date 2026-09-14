import { errorResponse, jsonResponse, parseJsonBody, updateCategory } from "../_db.js";

export async function onRequestPost(context) {
  try {
    const data = await parseJsonBody(context.request);
    return jsonResponse({ category: await updateCategory(context.env.DB, data.id, data.name, data.archived) });
  } catch (err) { return errorResponse(err.message, 400); }
}
