// Failed-login rate limiting backed by Cloudflare D1 (shared across isolates).
//
// Fixed window per client IP: after MAX_ATTEMPTS failed logins within
// WINDOW_SECONDS further attempts are rejected with 429 until the window
// expires. A successful login clears the counter for that IP.

import { ensureSchema } from "./_db.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 900;
const RETENTION_SECONDS = 24 * 60 * 60;

function positiveIntEnv(env, name, fallback) {
  const value = Number.parseInt(String(env?.[name] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getRateLimitSettings(env) {
  return {
    maxAttempts: positiveIntEnv(env, "AUTH_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    windowSeconds: positiveIntEnv(env, "AUTH_LOCKOUT_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS),
  };
}

export function getClientIp(request) {
  const forwardedFor = (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim();
  return (
    request.headers.get("CF-Connecting-IP") ||
    forwardedFor ||
    "local"
  );
}

// Returns { locked, retryAfter } — must be called BEFORE comparing the PIN,
// so a locked-out IP never burns attempts or writes to D1.
export async function checkLockout(env, ip) {
  const { maxAttempts, windowSeconds } = getRateLimitSettings(env);
  const now = Math.floor(Date.now() / 1000);

  await ensureSchema(env.DB);
  const row = await env.DB
    .prepare("SELECT window_start, fail_count FROM login_attempts WHERE ip = ?")
    .bind(ip)
    .first();

  if (!row) {
    return { locked: false, retryAfter: 0 };
  }

  const windowStart = Number(row.window_start);
  const failCount = Number(row.fail_count);

  if (now - windowStart >= windowSeconds) {
    return { locked: false, retryAfter: 0 };
  }
  if (failCount >= maxAttempts) {
    return { locked: true, retryAfter: windowStart + windowSeconds - now };
  }
  return { locked: false, retryAfter: 0 };
}

export async function registerFailedAttempt(env, ip) {
  const { windowSeconds } = getRateLimitSettings(env);
  const now = Math.floor(Date.now() / 1000);

  await ensureSchema(env.DB);
  await env.DB
    .prepare(
      `INSERT INTO login_attempts (ip, window_start, fail_count)
       VALUES (?, ?, 1)
       ON CONFLICT(ip) DO UPDATE SET
         fail_count = CASE WHEN ? - window_start >= ? THEN 1 ELSE fail_count + 1 END,
         window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`
    )
    .bind(ip, now, now, windowSeconds, now, windowSeconds, now)
    .run();

  // Opportunistic cleanup of long-expired rows; the table stays tiny.
  await env.DB
    .prepare("DELETE FROM login_attempts WHERE window_start < ?")
    .bind(now - RETENTION_SECONDS)
    .run();
}

export async function clearFailedAttempts(env, ip) {
  await env.DB
    .prepare("DELETE FROM login_attempts WHERE ip = ?")
    .bind(ip)
    .run();
}
