import { jsonNoStore, badRequest } from '../../utils/response.js';
import { timingSafeEqual } from '../../utils/crypto.js';
import { issueAdminSessionToken, verifyAdminSessionToken } from '../../utils/session.js';
import { requireTurnstileOr403 } from '../../utils/turnstile.js';
import { readJson } from '../../utils/http.js';

export function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer realm=\"admin\"" }
  });
}

/**
 * Bearer must be a session token issued by POST /api/admin/session.
 * The raw ADMIN_TOKEN is deliberately not accepted here.
 * @returns {Promise<Response|null>} 401 Response or null when authorized
 */
export async function authorizeAdmin(request, env) {
  const expected = String(env.ADMIN_TOKEN || "");
  if (!expected) return unauthorized();
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : "";
  if (!token) return unauthorized();

  const v = await verifyAdminSessionToken(token, expected);
  if (!v.ok) return unauthorized();
  return null;
}

/** POST /api/admin/session — exchange ADMIN_TOKEN (+ Turnstile) for a signed session token. */
export async function handleSession({ request, env }) {
  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");
  const provided = String(body.token || body.adminToken || "");
  const turnstileToken = String(body.turnstileToken || "");
  const expected = String(env.ADMIN_TOKEN || "");
  if (!expected) return unauthorized();

  if (env.TURNSTILE_SECRET_KEY) {
    const err = await requireTurnstileOr403(request, {
      token: turnstileToken,
      secretKey: env.TURNSTILE_SECRET_KEY,
      timeoutMs: Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000
    });
    if (err) return err;
  }

  if (!provided || !timingSafeEqual(provided, expected)) return unauthorized();

  const issued = await issueAdminSessionToken(expected);
  return jsonNoStore({ sessionToken: issued.token, iat: issued.payload.iat, exp: issued.payload.exp });
}
