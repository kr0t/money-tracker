import { createCategory, errorResponse, jsonResponse, listCategories, parseJsonBody } from "./_db.js";

export async function onRequest(context) {
  try {
    if (context.request.method === "GET") return jsonResponse({ categories: await listCategories(context.env.DB) });
    if (context.request.method === "POST") return jsonResponse({ category: await createCategory(context.env.DB, (await parseJsonBody(context.request)).name) }, 201);
    return errorResponse("method not allowed", 405);
  } catch (err) { return errorResponse(err.message, 400); }
}
