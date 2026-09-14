import { errorResponse, getAnalytics, jsonResponse } from "./_db.js";

export async function onRequestGet(context) {
  try { return jsonResponse(await getAnalytics(context.env.DB, new URL(context.request.url).searchParams.get("month"))); }
  catch (err) { return errorResponse(err.message, 400); }
}
