/**
 * Create JSON response
 * @param {Object} obj - Object to serialize
 * @param {number} status - HTTP status code
 * @param {Object} extraHeaders - Additional headers
 * @returns {Response}
 */
export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

