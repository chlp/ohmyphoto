/**
 * SHA-256 hex digest for a string (Workers runtime).
 * @param {string} input
 * @returns {Promise<string>} lowercase hex
 */
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(hash));
}

/**
 * HMAC-SHA256 over a string message with a string key.
 * @param {string} keyString
 * @param {string} messageString
 * @returns {Promise<Uint8Array>}
 */
export async function hmacSha256Bytes(keyString, messageString) {
  const keyData = new TextEncoder().encode(String(keyString));
  const msgData = new TextEncoder().encode(String(messageString));
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, msgData);
  return new Uint8Array(sig);
}

/**
 * HMAC-SHA256 as lowercase hex.
 * @param {string} keyString
 * @param {string} messageString
 * @returns {Promise<string>}
 */
export async function hmacSha256Hex(keyString, messageString) {
  return bytesToHex(await hmacSha256Bytes(keyString, messageString));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex
 */
export function bytesToHex(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Cryptographically random lowercase hex string of `byteLength` bytes (2 chars per byte).
 * @param {number} byteLength
 * @returns {string}
 */
export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Timing-safe string compare.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * Signature for image URLs: HMAC-SHA256(key = secret, message = `${albumId}:${ref}`), hex.
 * The admin UI computes the same value client-side (see admin.template.html).
 * @param {string} albumId
 * @param {string} ref photo ref (sha256 hex)
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function imageSig(albumId, ref, secret) {
  return hmacSha256Hex(secret, `${albumId}:${ref}`);
}
