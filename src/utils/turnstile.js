import { getClientIp } from './http.js';

/**
 * Verify Cloudflare Turnstile token
 * @param {string} token - Turnstile token from client
 * @param {string} secretKey - Turnstile secret key from env
 * @param {string} remoteip - Optional client IP
 * @param {number} timeoutMs - Abort verification request after this timeout (ms)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function verifyTurnstileToken(token, secretKey, remoteip = null, timeoutMs = 5000) {
  if (!token || !secretKey) {
    return { success: false, error: 'Missing token or secret key' };
  }

  const formData = new FormData();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (remoteip) {
    formData.append('remoteip', remoteip);
  }

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('Turnstile verification timeout')), Number(timeoutMs) || 5000);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      signal: ac.signal
    }).finally(() => clearTimeout(t));

    const result = await response.json();
    
    if (result.success) {
      return { success: true };
    } else {
      return { 
        success: false, 
        error: result['error-codes']?.join(', ') || 'Turnstile verification failed' 
      };
    }
  } catch (error) {
    return { 
      success: false, 
      error: `Turnstile verification error: ${error.message}` 
    };
  }
}

/**
 * Best-effort remote IP for Turnstile verification.
 * Returns null if unknown.
 * @param {Request} request
 * @returns {string|null}
 */
export function getTurnstileRemoteIp(request) {
  const ip = getClientIp(request);
  if (!ip || ip === "unknown") return null;
  return ip;
}

/**
 * Verify a Turnstile token for a given Request (auto-detect remote IP).
 * @param {Request} request
 * @param {string} token
 * @param {string} secretKey
 * @param {number} timeoutMs
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function verifyTurnstileRequest(request, token, secretKey, timeoutMs = 5000) {
  const remoteip = request ? getTurnstileRemoteIp(request) : null;
  return await verifyTurnstileToken(token, secretKey, remoteip, timeoutMs);
}

/**
 * Enforce Turnstile when secretKey is configured.
 * Returns a 403 Response on missing/failed verification, otherwise null.
 *
 * @param {Request} request
 * @param {{token: string, secretKey: string, timeoutMs?: number, messageRequired?: string, messageFailed?: string}} opts
 * @returns {Promise<Response|null>}
 */
export async function requireTurnstileOr403(request, opts) {
  const {
    token,
    secretKey,
    timeoutMs = 5000,
    messageRequired = "Bot verification required",
    messageFailed = "Bot verification failed"
  } = opts || {};

  if (!secretKey) return null;
  if (!token) return new Response(messageRequired, { status: 403 });

  const r = await verifyTurnstileRequest(request, token, secretKey, timeoutMs);
  if (!r.success) return new Response(messageFailed, { status: 403 });
  return null;
}

