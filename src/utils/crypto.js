/**
 * SHA-256 hex digest for a string (Workers runtime).
 * @param {string} input
 * @returns {Promise<string>} lowercase hex
 */
export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
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
 * Signature for image URLs: sha256hex(`${albumId}:${name}:${secret}`)
 * @param {string} albumId
 * @param {string} name
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function imageSig(albumId, name, secret) {
  return sha256Hex(`${albumId}:${name}:${secret}`);
}


