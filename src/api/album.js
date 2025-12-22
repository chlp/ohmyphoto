import { checkAlbumSecret } from '../utils/album.js';
import { json } from '../utils/response.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { imageSig } from '../utils/crypto.js';
import { issueHumanBypassToken, verifyHumanBypassToken } from '../utils/session.js';

function getCookieValue(cookieHeader, name) {
  const raw = String(cookieHeader || "");
  if (!raw) return "";
  const parts = raw.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return p.slice(idx + 1).trim();
  }
  return "";
}

function makeSetCookie({ name, value, maxAgeSec, secure }) {
  const attrs = [
    `${name}=${value}`,
    `Path=/`,
    `Max-Age=${Math.max(1, Math.floor(Number(maxAgeSec) || 0))}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

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

  // Verify Turnstile token if secret key is configured.
  // Optimization: if browser already passed Turnstile recently, accept a short-lived signed cookie.
  let setBypassCookie = false;
  let bypassCookieHeader = null;
  if (env.TURNSTILE_SECRET_KEY) {
    const cookieEnabled = String(env.TURNSTILE_BYPASS_COOKIE || "1") !== "0";
    const cookieName = String(env.TURNSTILE_BYPASS_COOKIE_NAME || "ohmyphoto_human");
    const ttlMs = Number(env.TURNSTILE_BYPASS_COOKIE_TTL_MS) || 30 * 60 * 1000;
    const ua = request.headers.get("User-Agent") || "";
    const secure = new URL(request.url).protocol === "https:";

    if (cookieEnabled) {
      const cookieToken = getCookieValue(request.headers.get("Cookie"), cookieName);
      if (cookieToken) {
        const tVerify = Date.now();
        const ok = await verifyHumanBypassToken(cookieToken, env.TURNSTILE_SECRET_KEY, ua);
        mark('turnstile_cookie', tVerify);
        if (ok.ok) {
          // Sliding TTL: refresh cookie.
          const issued = await issueHumanBypassToken(env.TURNSTILE_SECRET_KEY, ua, ttlMs);
          bypassCookieHeader = makeSetCookie({
            name: cookieName,
            value: issued.token,
            maxAgeSec: Math.floor(ttlMs / 1000),
            secure
          });
          setBypassCookie = true;
        }
      }
    }

    if (!setBypassCookie) {
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

      if (cookieEnabled) {
        const issued = await issueHumanBypassToken(env.TURNSTILE_SECRET_KEY, ua, ttlMs);
        bypassCookieHeader = makeSetCookie({
          name: cookieName,
          value: issued.token,
          maxAgeSec: Math.floor(ttlMs / 1000),
          secure
        });
        setBypassCookie = true;
      }
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

  const extra = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    ...debugHeaders()
  };
  if (setBypassCookie && bypassCookieHeader) {
    extra["Set-Cookie"] = bypassCookieHeader;
  }
  return json(resp, 200, extra);
}

