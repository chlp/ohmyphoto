import { checkAlbumSecret } from '../utils/album.js';
import { json } from '../utils/response.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { imageSig } from '../utils/crypto.js';

/**
 * Handle POST /api/album/<albumId>
 */
export async function handleAlbumRequest(request, env, albumId) {
  const debug = request.headers.get('X-OhMyPhoto-Debug') === '1';
  const reqId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  const timings = [];
  const mark = (name, startedAtMs) => timings.push([name, Date.now() - startedAtMs]);
  const debugHeaders = () => {
    if (!debug) return {};
    const serverTiming = timings.map(([n, d]) => `${n};dur=${Math.max(0, Number(d) || 0)}`).join(', ');
    return {
      'X-Request-Id': reqId,
      ...(serverTiming ? { 'Server-Timing': serverTiming } : {})
    };
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: debugHeaders() });
  }
  const secret = String(body?.secret || "");
  const turnstileToken = String(body?.turnstileToken || "");

  // Verify Turnstile token if secret key is configured
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      return new Response("Bot verification required", { status: 403, headers: debugHeaders() });
    }
    const clientIP = request.headers.get('CF-Connecting-IP') || null;
    const tTurnstile = Date.now();
    const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
    const turnstileResult = await verifyTurnstileToken(
      turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      clientIP,
      turnstileTimeoutMs
    );
    mark('turnstile', tTurnstile);
    if (!turnstileResult.success) {
      return new Response("Bot verification failed", { status: 403, headers: debugHeaders() });
    }
  }

  // Check if album exists and secret is valid
  const tSecret = Date.now();
  const checkResult = await checkAlbumSecret(albumId, secret, env);
  mark('check_secret', tSecret);
  if (!checkResult.success) {
    if (!debug) return checkResult.response;
    const r = checkResult.response;
    const headers = new Headers(r.headers);
    const dh = debugHeaders();
    for (const [k, v] of Object.entries(dh)) headers.set(k, v);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  }
  const info = checkResult.info;
  const matchedSecret = checkResult.matchedSecret;

  // LIST photos/
  const tList = Date.now();
  const prefix = `albums/${albumId}/photos/`;
  const listed = await env.BUCKET.list({ prefix });
  mark('r2_list', tList);

  const files = listed.objects
    .map(o => o.key)
    .filter(k => k !== prefix) // just in case
    .map(async (k) => {
      const name = k.substring(prefix.length);
      const sig = await imageSig(albumId, name, matchedSecret);
      const qs = `?s=${sig}`;
      return {
        name,
        photoUrl: `/img/${encodeURIComponent(albumId)}/photos/${encodeURIComponent(name)}${qs}`,
        previewUrl: `/img/${encodeURIComponent(albumId)}/preview/${encodeURIComponent(name)}${qs}`
      };
    });

  const tSig = Date.now();
  const resolvedFiles = await Promise.all(files);
  mark('sign_urls', tSig);

  const resp = {
    albumId,
    title: String(info?.title || "OhMyPhoto"),
    files: resolvedFiles
  };

  return json(resp, 200, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    ...debugHeaders()
  });
}

