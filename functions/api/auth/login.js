import { parseJsonBody, jsonResponse, errorResponse } from "../_db.js";
import {
  getExpectedPin,
  createAuthToken,
  createAuthCookieHeader,
} from "../_auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const body = await parseJsonBody(request);
  const pin = typeof body.pin === "string" ? body.pin.trim() : String(body.pin || "").trim();

  if (!pin) {
    return errorResponse("Введите PIN-код или пароль", 400);
  }

  const expectedPin = getExpectedPin(env);
  if (pin !== expectedPin) {
    return errorResponse("Неверный PIN-код или пароль", 401);
  }

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
