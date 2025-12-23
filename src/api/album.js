import { checkAlbumSecret } from '../utils/album.js';
import { json } from '../utils/response.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { imageSig } from '../utils/crypto.js';
import { issueHumanBypassToken, verifyHumanBypassToken } from '../utils/session.js';
import { getAlbumIndex } from '../utils/albumIndex.js';
import { getClientIp, readJson } from '../utils/http.js';
import { getCookieValue, makeSetCookie } from '../utils/cookies.js';

/**
 * Handle POST /api/album/<albumId>
 */
async function doFetchJsonWithTimeout(stub, url, body, timeoutMs) {
  return await Promise.race([
    stub.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

async function adjustTurnstileSoftCounter(env, ip, delta, windowMs) {
  if (!env || !env.RATE_LIMITER) return;
  const timeoutMs = Number(env.TURNSTILE_SOFT_DO_TIMEOUT_MS) || 300;
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`turnstile_soft:${ip}`));
  await doFetchJsonWithTimeout(
    stub,
    'https://rate-limiter/turnstile-soft',
    { action: 'adjust', delta, windowMs },
    timeoutMs
  ).catch(() => null);
}

async function peekTurnstileSoftCount(env, ip) {
  if (!env || !env.RATE_LIMITER) return false;
  const timeoutMs = Number(env.TURNSTILE_SOFT_DO_TIMEOUT_MS) || 300;
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`turnstile_soft:${ip}`));
  const r = await doFetchJsonWithTimeout(
    stub,
    'https://rate-limiter/turnstile-soft',
    { action: 'peek' },
    timeoutMs
  );
  if (!r || !r.ok) return { count: 0, resetAtMs: 0 }; // fail-open
  const data = await r.json().catch(() => null);
  if (!data || data.ok !== true) return { count: 0, resetAtMs: 0 };
  return { count: Number(data.count) || 0, resetAtMs: Number(data.resetAtMs) || 0 };
}

export async function handleAlbumRequest(request, env, albumId, ctx) {
  const body = await readJson(request);
  if (!body) {
    return new Response("Bad JSON", { status: 400 });
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
    const ttlMs = Number(env.TURNSTILE_BYPASS_COOKIE_TTL_MS) || 7 * 24 * 60 * 1000;
    const clientIp = getClientIp(request);
    const secure = new URL(request.url).protocol === "https:";

    if (cookieEnabled) {
      const cookieToken = getCookieValue(request.headers.get("Cookie"), cookieName);
      if (cookieToken) {
        const ok = await verifyHumanBypassToken(cookieToken, env.TURNSTILE_SECRET_KEY, clientIp);
        if (ok.ok) {
          // Sliding TTL: refresh cookie.
          const issued = await issueHumanBypassToken(env.TURNSTILE_SECRET_KEY, clientIp, ttlMs);
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

    // Soft Turnstile:
    // - Until an IP sends > threshold requests without a valid bypass cookie and without passing Turnstile,
    //   do NOT block the request and do NOT wait on Turnstile verification.
    // - If a token is provided, verify in the background and mark the IP as "ok" for ttlMs.
    // - Once the threshold is exceeded, require Turnstile (or cookie) synchronously.
    if (!setBypassCookie) {
      const threshold = Number(env.TURNSTILE_SOFT_THRESHOLD) || 100;
      const windowMs = Number(env.TURNSTILE_SOFT_WINDOW_MS) || 24 * 60 * 60 * 1000;
      const { count } = await peekTurnstileSoftCount(env, clientIp);
      const enforced = count >= threshold; // require Turnstile starting from (threshold + 1)-th "bad" request

      if (enforced) {
        if (!turnstileToken) {
          return new Response("Bot verification required", { status: 403 });
        }
        const clientIP = request.headers.get('CF-Connecting-IP') || null;
        const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
        const turnstileResult = await verifyTurnstileToken(
          turnstileToken,
          env.TURNSTILE_SECRET_KEY,
          clientIP,
          turnstileTimeoutMs
        );
        if (!turnstileResult.success) {
          return new Response("Bot verification failed", { status: 403 });
        }

        // Success: do not touch the counter here.

        if (cookieEnabled) {
          const issued = await issueHumanBypassToken(env.TURNSTILE_SECRET_KEY, clientIp, ttlMs);
          bypassCookieHeader = makeSetCookie({
            name: cookieName,
            value: issued.token,
            maxAgeSec: Math.floor(ttlMs / 1000),
            secure
          });
          setBypassCookie = true;
        }
      } else {
        // Not enforced yet: allow request to proceed without waiting.
        // Only mutate the counter when we *know* the request didn't pass Turnstile:
        // - no token => increment immediately
        // - token present => verify in background; increment only on failure/unverified
        if (!turnstileToken) {
          await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
        } else if (ctx && typeof ctx.waitUntil === 'function') {
          const clientIP = request.headers.get('CF-Connecting-IP') || null;
          const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
          ctx.waitUntil((async () => {
            try {
              const r = await verifyTurnstileToken(
                turnstileToken,
                env.TURNSTILE_SECRET_KEY,
                clientIP,
                turnstileTimeoutMs
              );
              if (r && r.success) return;
              await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
            } catch {
              // On errors/timeouts treat as unverified -> count it.
              await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
            }
          })());
        } else {
          // No ctx.waitUntil in this environment: treat as unverified.
          await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
        }
      }
    }
  }

  // Check if album exists and secret is valid
  const checkResult = await checkAlbumSecret(albumId, secret, env);
  if (!checkResult.success) {
    return checkResult.response;
  }
  const info = checkResult.info;
  const matchedSecret = checkResult.matchedSecret;

  // LIST photos/ (cached via Durable Object when available)
  const idx = await getAlbumIndex(env, albumId);
  let names = null;
  if (idx && idx.ok) {
    names = idx.files.map((f) => f.name);
  }
  if (!names) {
    // Fallback: direct R2 list (best-effort), same behavior as before.
    const prefix = `albums/${albumId}/photos/`;
    const listed = await env.BUCKET.list({ prefix });
    names = listed.objects
      .map(o => o.key)
      .filter(k => k !== prefix)
      .map(k => k.substring(prefix.length));
  }

  const files = names.map(async (name) => {
    const sig = await imageSig(albumId, name, matchedSecret);
    const qs = `?s=${sig}`;
    return {
      name,
      photoUrl: `/img/${encodeURIComponent(albumId)}/photos/${encodeURIComponent(name)}${qs}`,
      previewUrl: `/img/${encodeURIComponent(albumId)}/preview/${encodeURIComponent(name)}${qs}`
    };
  });

  const resolvedFiles = await Promise.all(files);

  const resp = {
    albumId,
    title: String(info?.title || "OhMyPhoto"),
    files: resolvedFiles
  };

  const extra = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  };
  if (setBypassCookie && bypassCookieHeader) {
    extra["Set-Cookie"] = bypassCookieHeader;
  }
  return json(resp, 200, extra);
}

