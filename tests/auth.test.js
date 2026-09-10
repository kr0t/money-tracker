import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthConfigError,
  getAuthConfig,
  createAuthToken,
  verifyAuthToken,
} from "../functions/api/_auth.js";

const VALID_ENV = {
  AUTH_PIN: "1234",
  AUTH_SECRET: "unit-test-secret-0123456789abcdef",
};

test("getAuthConfig returns cleaned values", () => {
  const config = getAuthConfig({
    AUTH_PIN: ' " 1234 " ',
    AUTH_SECRET: `"${VALID_ENV.AUTH_SECRET}"`,
  });
  assert.equal(config.pin, "1234");
  assert.equal(config.secret, VALID_ENV.AUTH_SECRET);
});

test("getAuthConfig rejects missing or weak config", () => {
  assert.throws(() => getAuthConfig({}), AuthConfigError);
  assert.throws(() => getAuthConfig({ AUTH_PIN: "1234" }), AuthConfigError);
  assert.throws(() => getAuthConfig({ AUTH_SECRET: VALID_ENV.AUTH_SECRET }), AuthConfigError);
  assert.throws(
    () => getAuthConfig({ AUTH_PIN: "1234", AUTH_SECRET: "short" }),
    AuthConfigError
  );
  const longPin = "0123456789abcdef0123456789abcdef";
  assert.throws(
    () => getAuthConfig({ AUTH_PIN: longPin, AUTH_SECRET: longPin }),
    AuthConfigError
  );
});

test("token roundtrip", async () => {
  const token = await createAuthToken(VALID_ENV);
  assert.ok(await verifyAuthToken(token, VALID_ENV));
});

test("token rejected with wrong secret", async () => {
  const token = await createAuthToken(VALID_ENV);
  const otherEnv = { ...VALID_ENV, AUTH_SECRET: "other-secret-0123456789abcdef" };
  assert.equal(await verifyAuthToken(token, otherEnv), false);
});

test("tampered signature rejected", async () => {
  const token = await createAuthToken(VALID_ENV);
  const [payload, sig] = token.split(".");
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  assert.equal(await verifyAuthToken(`${payload}.${flipped}`, VALID_ENV), false);
});

test("tampered payload rejected", async () => {
  const token = await createAuthToken(VALID_ENV);
  const [payload, sig] = token.split(".");
  assert.equal(await verifyAuthToken(`x${payload}.${sig}`, VALID_ENV), false);
});

test("verifyAuthToken fails closed without config", async () => {
  assert.equal(await verifyAuthToken("anything.at-all", {}), false);
  assert.equal(await verifyAuthToken(null, VALID_ENV), false);
  assert.equal(await verifyAuthToken("", VALID_ENV), false);
  assert.equal(await verifyAuthToken("a.b.c", VALID_ENV), false);
});

test("expired token rejected", async () => {
  const enc = new TextEncoder();
  const payloadStr = JSON.stringify({ iat: 1, exp: 1 });
  const payloadB64 = btoa(payloadStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(VALID_ENV.AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  const sigHex = Buffer.from(sigBuffer).toString("hex");
  assert.equal(await verifyAuthToken(`${payloadB64}.${sigHex}`, VALID_ENV), false);
});

test("createAuthToken requires valid config", async () => {
  await assert.rejects(() => createAuthToken({}), AuthConfigError);
});
