/**
 * Small HTTP/request helpers.
 */

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


