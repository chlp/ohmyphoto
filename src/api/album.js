import { checkAlbumSecret } from '../utils/album.js';
import { json } from '../utils/response.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { imageSig } from '../utils/crypto.js';
import { issueHumanBypassToken, verifyHumanBypassToken } from '../utils/session.js';
import { getClientIp, readJson } from '../utils/http.js';
import { getCookieValue, makeSetCookie } from '../utils/cookies.js';
import { isValidPhotoFileName } from '../utils/validate.js';

/**
 * Handle POST /api/album/<albumId>
 */
function __ompNowMs() {
  // Workers has performance.now(); keep a fallback for safety.
  try {
    // eslint-disable-next-line no-undef
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch {}
  return Date.now();
}

function __ompFormatServerTiming(parts) {
  // parts: Array<[name, durMs]>
  return parts
    .filter(([name, dur]) => name && Number.isFinite(dur) && dur >= 0)
    .map(([name, dur]) => `${String(name).replace(/[^a-zA-Z0-9_\\-\\.]/g, '')};dur=${dur.toFixed(1)}`)
    .join(', ');
}

async function doFetchJsonWithTimeout(stub, url, body, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await stub.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
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
  if (!env || !env.RATE_LIMITER) return { count: 0, resetAtMs: 0 }; // fail-open
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
  const __tStart = __ompNowMs();
  const __timings = [];
  const __mark = (name, t0) => {
    const dt = __ompNowMs() - t0;
    __timings.push([name, dt]);
    return dt;
  };

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
    const __tTurnstile = __ompNowMs();
    const cookieEnabled = String(env.TURNSTILE_BYPASS_COOKIE || "1") !== "0";
    const cookieName = String(env.TURNSTILE_BYPASS_COOKIE_NAME || "ohmyphoto_human");
    const ttlMs = Number(env.TURNSTILE_BYPASS_COOKIE_TTL_MS) || 7 * 24 * 60 * 1000;
    const clientIp = getClientIp(request);
    const secure = new URL(request.url).protocol === "https:";

    if (cookieEnabled) {
      const __tCookie = __ompNowMs();
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
      __mark('turnstile_cookie', __tCookie);
    }

    // Soft Turnstile:
    // - Until an IP sends > threshold requests without a valid bypass cookie and without passing Turnstile,
    //   do NOT block the request and do NOT wait on Turnstile verification.
    // - If a token is provided, verify in the background and mark the IP as "ok" for ttlMs.
    // - Once the threshold is exceeded, require Turnstile (or cookie) synchronously.
    if (!setBypassCookie) {
      const threshold = Number(env.TURNSTILE_SOFT_THRESHOLD) || 100;
      const windowMs = Number(env.TURNSTILE_SOFT_WINDOW_MS) || 24 * 60 * 60 * 1000;
      const __tPeek = __ompNowMs();
      const { count } = await peekTurnstileSoftCount(env, clientIp);
      __mark('turnstile_soft_peek', __tPeek);
      const enforced = count >= threshold; // require Turnstile starting from (threshold + 1)-th "bad" request

      if (enforced) {
        if (!turnstileToken) {
          return new Response("Bot verification required", { status: 403 });
        }
        const clientIP = request.headers.get('CF-Connecting-IP') || null;
        const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
        const __tVerify = __ompNowMs();
        const turnstileResult = await verifyTurnstileToken(
          turnstileToken,
          env.TURNSTILE_SECRET_KEY,
          clientIP,
          turnstileTimeoutMs
        );
        __mark('turnstile_verify', __tVerify);
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
          const __tAdjust = __ompNowMs();
          await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
          __mark('turnstile_soft_adjust', __tAdjust);
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
          const __tAdjust = __ompNowMs();
          await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
          __mark('turnstile_soft_adjust', __tAdjust);
        }
      }
    }
    __mark('turnstile_total', __tTurnstile);
  }

  // Check if album exists and secret is valid
  const __tSecret = __ompNowMs();
  const checkResult = await checkAlbumSecret(albumId, secret, env);
  __mark('album_secret', __tSecret);
  if (!checkResult.success) {
    return checkResult.response;
  }
  const info = checkResult.info;
  const matchedSecret = checkResult.matchedSecret;

  // NO LISTING: photo list must be provided in info.json (managed via admin)
  const __tFiles = __ompNowMs();
  const rawFiles = info && Array.isArray(info.files) ? info.files : null;
  if (!rawFiles) {
    return new Response("Album is missing files list in info.json", { status: 500 });
  }
  const names = rawFiles
    .map((n) => String(n || "").trim())
    .filter((n) => isValidPhotoFileName(n));
  __mark('album_files_info', __tFiles);

  const __tSig = __ompNowMs();
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
  __mark('image_sig_all', __tSig);

  const resp = {
    albumId,
    title: String(info?.title || "OhMyPhoto"),
    files: resolvedFiles
  };

  const extra = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "Server-Timing": __ompFormatServerTiming([...__timings, ['total', (__ompNowMs() - __tStart)]]),
    "X-OhMyPhoto-Index": "info_json",
    "X-OhMyPhoto-FileCount": String(Array.isArray(names) ? names.length : 0),
  };
  if (setBypassCookie && bypassCookieHeader) {
    extra["Set-Cookie"] = bypassCookieHeader;
  }
  return json(resp, 200, extra);
}

