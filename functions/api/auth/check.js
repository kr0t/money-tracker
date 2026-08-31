import { jsonResponse } from "../_db.js";
import { getAuthTokenFromRequest, verifyAuthToken } from "../_auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = getAuthTokenFromRequest(request);
  const isAuthenticated = await verifyAuthToken(token, env);

  return jsonResponse({ authenticated: isAuthenticated });
}
