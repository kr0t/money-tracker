// Authentication & HMAC crypto helpers for Cloudflare Pages Functions

const COOKIE_NAME = "mt_auth";
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MIN_SECRET_LENGTH = 16;

export class AuthConfigError extends Error {}

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

function encodePayloadB64(payloadStr) {
  return btoa(payloadStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodePayloadB64(payloadB64) {
  let base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) {
    base64 += "=".repeat(4 - pad);
  }
  return atob(base64);
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

function cleanEnvValue(raw) {
  let text = String(raw ?? "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

// Fail-closed: AUTH_PIN and AUTH_SECRET are mandatory. No default PIN,
// no default signing secret. Throws AuthConfigError on any misconfiguration.
export function getAuthConfig(env) {
  const pin = cleanEnvValue(env?.AUTH_PIN);
  const secret = cleanEnvValue(env?.AUTH_SECRET);

  if (!pin) {
    throw new AuthConfigError("AUTH_PIN is not configured");
  }
  if (!secret) {
    throw new AuthConfigError("AUTH_SECRET is not configured");
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(
      `AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (use: openssl rand -hex 32)`
    );
  }
  if (secret === pin) {
    throw new AuthConfigError("AUTH_SECRET must differ from AUTH_PIN");
  }

  return { pin, secret };
}

export async function createAuthToken(env) {
  const { secret } = getAuthConfig(env);

  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = encodePayloadB64(payloadStr);

  const enc = new TextEncoder();
  const key = await getHmacKey(secret);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const signatureHex = bufferToHex(signatureBuffer);

  return `${payloadB64}.${signatureHex}`;
}

export async function verifyAuthToken(token, env) {
  let secret;
  try {
    secret = getAuthConfig(env).secret;
  } catch {
    // Fail-closed: without a valid secret nothing can be verified.
    return false;
  }

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
  const key = await getHmacKey(secret);
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
    const payloadStr = decodePayloadB64(payloadB64);
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
  header.split(";").forEach((cookiePart) => {
    const trimmed = cookiePart.trim();
    if (!trimmed) {
      return;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      return;
    }
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1);
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
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
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; ${secureFlag}SameSite=Lax; Max-Age=${TOKEN_TTL_SECONDS}`;
}

export function createLogoutCookieHeader(isSecure = true) {
  const secureFlag = isSecure ? "Secure; " : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; ${secureFlag}SameSite=Lax; Max-Age=0`;
}
