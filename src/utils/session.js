function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJson(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  return base64UrlEncode(bytes);
}

function base64UrlDecodeToBytes(b64url) {
  const b64 = String(b64url).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

import { sha256Hex } from "./crypto.js";

async function hmacSha256Bytes(keyString, messageString) {
  const keyData = new TextEncoder().encode(String(keyString));
  const msgData = new TextEncoder().encode(String(messageString));
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgData);
  return new Uint8Array(sig);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * Issue an admin session token, signed with ADMIN_TOKEN (HMAC-SHA256).
 * Token format: base64url(payloadJson) + "." + base64url(hmac(payload))
 */
export async function issueAdminSessionToken(adminToken, nowMs = Date.now()) {
  const iat = nowMs;
  const exp = nowMs + 7 * 24 * 60 * 60 * 1000;
  const payload = { v: 1, iat, exp };
  const payloadB64 = base64UrlEncodeJson(payload);
  const sigBytes = await hmacSha256Bytes(adminToken, payloadB64);
  const sigB64 = base64UrlEncode(sigBytes);
  return { token: `${payloadB64}.${sigB64}`, payload };
}

/**
 * Verify admin session token.
 * @returns {{ok:true,payload:any}|{ok:false}}
 */
export async function verifyAdminSessionToken(sessionToken, adminToken, nowMs = Date.now()) {
  const t = String(sessionToken || "");
  const parts = t.split(".");
  if (parts.length !== 2) return { ok: false };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { ok: false };

  const expectedSigBytes = await hmacSha256Bytes(adminToken, payloadB64);
  const expectedSigB64 = base64UrlEncode(expectedSigBytes);
  if (!timingSafeEqual(expectedSigB64, sigB64)) return { ok: false };

  const payloadBytes = base64UrlDecodeToBytes(payloadB64);
  const payloadStr = new TextDecoder().decode(payloadBytes);
  const payload = safeJsonParse(payloadStr);
  if (!payload || typeof payload !== "object") return { ok: false };
  if (payload.v !== 1) return { ok: false };
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return { ok: false };
  if (payload.exp <= nowMs) return { ok: false };

  return { ok: true, payload };
}

/**
 * Issue a short-lived "human verified" token (HMAC-SHA256), meant to be stored in a cookie.
 * Token format: base64url(payloadJson) + "." + base64url(hmac(payload))
 *
 * Payload includes a short hash of the User-Agent to reduce cookie re-use across different clients.
 */
export async function issueHumanBypassToken(secretKey, userAgent, ttlMs = 30 * 60 * 1000, nowMs = Date.now()) {
  const iat = nowMs;
  const exp = nowMs + Math.max(5_000, Number(ttlMs) || 0);
  const uaHash = String(await sha256Hex(String(userAgent || ""))).slice(0, 16);
  const payload = { v: 1, iat, exp, u: uaHash };
  const payloadB64 = base64UrlEncodeJson(payload);
  const sigBytes = await hmacSha256Bytes(secretKey, payloadB64);
  const sigB64 = base64UrlEncode(sigBytes);
  return { token: `${payloadB64}.${sigB64}`, payload };
}

/**
 * Verify "human verified" token.
 * @returns {{ok:true,payload:any}|{ok:false}}
 */
export async function verifyHumanBypassToken(token, secretKey, userAgent, nowMs = Date.now()) {
  const t = String(token || "");
  const parts = t.split(".");
  if (parts.length !== 2) return { ok: false };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return { ok: false };

  const expectedSigBytes = await hmacSha256Bytes(secretKey, payloadB64);
  const expectedSigB64 = base64UrlEncode(expectedSigBytes);
  if (!timingSafeEqual(expectedSigB64, sigB64)) return { ok: false };

  const payloadBytes = base64UrlDecodeToBytes(payloadB64);
  const payloadStr = new TextDecoder().decode(payloadBytes);
  const payload = safeJsonParse(payloadStr);
  if (!payload || typeof payload !== "object") return { ok: false };
  if (payload.v !== 1) return { ok: false };
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return { ok: false };
  if (payload.exp <= nowMs) return { ok: false };

  const uaHash = String(await sha256Hex(String(userAgent || ""))).slice(0, 16);
  if (typeof payload.u !== "string" || payload.u !== uaHash) return { ok: false };

  return { ok: true, payload };
}


