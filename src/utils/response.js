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

