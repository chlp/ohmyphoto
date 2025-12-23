/**
 * Small HTTP/request helpers.
 */

/**
 * Best-effort client IP extraction.
 * - Cloudflare: CF-Connecting-IP
 * - Fallback: first value in X-Forwarded-For
 *
 * Note: in local dev this may be missing; returns "unknown".
 * @param {Request} request
 * @returns {string}
 */
export function getClientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf;
  const xff = request.headers.get("X-Forwarded-For") || "";
  const first = xff.split(",")[0].trim();
  return first || "unknown";
}

/**
 * Best-effort JSON body parse.
 * Returns null on parse errors.
 * @param {Request} request
 * @returns {Promise<any|null>}
 */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}


