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

/**
 * JSON response that must never be cached (admin/API mutations).
 * @param {Object} obj
 * @param {number} status
 * @param {Object} extraHeaders
 * @returns {Response}
 */
export function jsonNoStore(obj = {}, status = 200, extraHeaders = {}) {
  return json(obj, status, { "Cache-Control": "no-store", ...extraHeaders });
}

/**
 * Create plain-text response.
 * @param {string} body
 * @param {number} status
 * @param {Object} extraHeaders
 * @returns {Response}
 */
export function text(body, status = 200, extraHeaders = {}) {
  return new Response(String(body), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders
    }
  });
}

export function notFound(extraHeaders = {}) {
  return text("Not found", 404, extraHeaders);
}

export function forbidden(extraHeaders = {}) {
  return text("Forbidden", 403, extraHeaders);
}

export function badRequest(msg = "Bad request") {
  return jsonNoStore({ error: msg }, 400);
}

export function conflict(msg = "Conflict") {
  return jsonNoStore({ error: msg }, 409);
}
