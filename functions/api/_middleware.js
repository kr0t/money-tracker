import { errorResponse } from "./_db.js";
import { getAuthTokenFromRequest, verifyAuthToken } from "./_auth.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Allow auth endpoints without authentication
  if (
    url.pathname === "/api/auth/login" ||
    url.pathname === "/api/auth/check" ||
    url.pathname === "/api/auth/logout"
  ) {
    return next();
  }

  const token = getAuthTokenFromRequest(request);
  const isValid = await verifyAuthToken(token, env);

  if (!isValid) {
    return errorResponse("Требуется авторизация", 401);
  }

  return next();
}
