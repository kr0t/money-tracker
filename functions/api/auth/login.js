import { parseJsonBody, errorResponse, jsonResponse } from "../_db.js";
import {
  AuthConfigError,
  getAuthConfig,
  createAuthToken,
  createAuthCookieHeader,
} from "../_auth.js";
import {
  getClientIp,
  checkLockout,
  registerFailedAttempt,
  clearFailedAttempts,
} from "../_ratelimit.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (err) {
    return errorResponse(err.message, 400);
  }

  let config;
  try {
    config = getAuthConfig(env);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error(`[auth] ${err.message}`);
      return errorResponse("Сервер не настроен: задайте AUTH_PIN и AUTH_SECRET", 500);
    }
    throw err;
  }

  const ip = getClientIp(request);
  const lockout = await checkLockout(env, ip);
  if (lockout.locked) {
    return jsonResponse(
      { error: "Слишком много неудачных попыток. Попробуйте позже." },
      429,
      { "Retry-After": String(Math.max(lockout.retryAfter, 1)) }
    );
  }

  const pin = typeof body.pin === "string" ? body.pin.trim() : String(body.pin || "").trim();
  if (!pin) {
    return errorResponse("Введите PIN-код или пароль", 400);
  }

  if (pin !== config.pin) {
    await registerFailedAttempt(env, ip);
    return errorResponse("Неверный PIN-код или пароль", 401);
  }

  await clearFailedAttempts(env, ip);

  const token = await createAuthToken(env);
  const isSecure = new URL(request.url).protocol === "https:";
  const cookieHeader = createAuthCookieHeader(token, isSecure);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": cookieHeader,
      "Cache-Control": "no-store",
    },
  });
}
