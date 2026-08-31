import { createLogoutCookieHeader } from "../_auth.js";

export async function onRequestPost(context) {
  const { request } = context;
  const isSecure = new URL(request.url).protocol === "https:";
  const cookieHeader = createLogoutCookieHeader(isSecure);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": cookieHeader,
      "Cache-Control": "no-store",
    },
  });
}
