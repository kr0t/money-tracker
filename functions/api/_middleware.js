import { errorResponse } from "./_db.js";
import { getAuthTokenFromRequest, verifyAuthToken } from "./_auth.js";

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // Allow auth endpoints without authentication
  if (
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/check" ||
    pathname === "/api/auth/logout"
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
