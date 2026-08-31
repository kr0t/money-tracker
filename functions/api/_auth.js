// Authentication & HMAC crypto helpers for Cloudflare Pages Functions

const COOKIE_NAME = "mt_auth";
const DEFAULT_PIN = "1234";
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBuffer(hex) {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const val = parseInt(hex.substring(i, i + 2), 16);
    if (isNaN(val)) return null;
    bytes[i / 2] = val;
  }
  return bytes.buffer;
}

async function getHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function getSecret(env) {
  const secret = (env && (env.AUTH_SECRET || env.AUTH_PIN)) || "money-tracker-default-secret";
  return String(secret);
}

export function getExpectedPin(env) {
  const pin = env && env.AUTH_PIN !== undefined && env.AUTH_PIN !== null ? env.AUTH_PIN : DEFAULT_PIN;
  return String(pin).trim();
}

export async function createAuthToken(env) {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(payloadStr);

  const enc = new TextEncoder();
  const key = await getHmacKey(getSecret(env));
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const signatureHex = bufferToHex(signatureBuffer);

  return `${payloadB64}.${signatureHex}`;
}

export async function verifyAuthToken(token, env) {
  if (!token || typeof token !== "string") {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [payloadB64, signatureHex] = parts;
  const sigBuffer = hexToBuffer(signatureHex);
  if (!sigBuffer) {
    return false;
  }

  const enc = new TextEncoder();
  const key = await getHmacKey(getSecret(env));
  const isValidSig = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBuffer,
    enc.encode(payloadB64)
  );

  if (!isValidSig) {
    return false;
  }

  try {
    const payloadStr = atob(payloadB64);
    const payload = JSON.parse(payloadStr);
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};
  header.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name) {
      cookies[name] = decodeURIComponent(rest.join("="));
    }
  });
  return cookies;
}

export function getAuthTokenFromRequest(request) {
  const cookies = parseCookies(request);
  return cookies[COOKIE_NAME] || null;
}

export function createAuthCookieHeader(token, isSecure = true) {
  const secureFlag = isSecure ? "Secure; " : "";
  return `${COOKIE_NAME}=${encodeURIComponent(
    token
  )}; Path=/; HttpOnly; ${secureFlag}SameSite=Lax; Max-Age=${TOKEN_TTL_SECONDS}`;
}

export function createLogoutCookieHeader(isSecure = true) {
  const secureFlag = isSecure ? "Secure; " : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; ${secureFlag}SameSite=Lax; Max-Age=0`;
}
