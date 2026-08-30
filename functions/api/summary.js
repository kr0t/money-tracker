import { getSummary, jsonResponse, errorResponse } from "./_db.js";

export async function onRequestGet(context) {
  try {
    const summary = await getSummary(context.env.DB);
    return jsonResponse(summary);
  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
