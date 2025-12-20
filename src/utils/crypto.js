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
 * Signature for image URLs: sha256hex(`${albumId}:${name}:${secret}`)
 * @param {string} albumId
 * @param {string} name
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function imageSig(albumId, name, secret) {
  return sha256Hex(`${albumId}:${name}:${secret}`);
}


