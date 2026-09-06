import { checkAlbumSecret, recordAlbumView } from '../utils/album.js';
import { json } from '../utils/response.js';
import { requireTurnstileOr403, verifyTurnstileRequest } from '../utils/turnstile.js';
import { imageSig } from '../utils/crypto.js';
import { issueHumanBypassToken, verifyHumanBypassToken } from '../utils/session.js';
import { getClientIp, readJson } from '../utils/http.js';
import { getCookieValue, makeSetCookie } from '../utils/cookies.js';
import { parseFileEntries } from '../utils/albumFiles.js';
import { zipPolicy } from '../utils/albumZip.js';

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
  // NOTE: Durable Object `stub.fetch()` does not reliably support AbortController.
  // Use Promise.race() to cap time spent awaiting the DO response (fail-open on timeout).
  const ms = Number(timeoutMs) || 0;
  const p = stub.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!(ms > 0)) return await p;
  return await Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

async function adjustTurnstileSoftCounter(env, ip, delta, windowMs) {
  if (!env || !env.RATE_LIMITER) return;
  const timeoutMs =
    Number(env.TURNSTILE_SOFT_ADJUST_TIMEOUT_MS) ||
    Number(env.TURNSTILE_SOFT_DO_TIMEOUT_MS) ||
    80;
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
  const timeoutMs =
    Number(env.TURNSTILE_SOFT_PEEK_TIMEOUT_MS) ||
    Number(env.TURNSTILE_SOFT_DO_TIMEOUT_MS) ||
    80;
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

  // Kick off the info.json / secret check now so it overlaps with the Turnstile
  // soft-counter round-trip below instead of running after it.
  const __tSecret = __ompNowMs();
  const secretCheckPromise = checkAlbumSecret(albumId, secret, env);
  secretCheckPromise.catch(() => {}); // avoid unhandled rejection if we return early (403)

  // Verify Turnstile token if secret key is configured.
  // Optimization: if browser already passed Turnstile recently, accept a short-lived signed cookie.
  let setBypassCookie = false;
  let bypassCookieHeader = null;
  // Set in soft mode; called only when the secret check fails (403/404).
  let penalizeIfSuspicious = null;
  // Issues (or refreshes) the IP-bound bypass cookie; no-op when cookies are disabled.
  let issueBypassCookie = async () => {};
  if (env.TURNSTILE_SECRET_KEY) {
    const __tTurnstile = __ompNowMs();
    const cookieEnabled = String(env.TURNSTILE_BYPASS_COOKIE || "1") !== "0";
    const cookieName = String(env.TURNSTILE_BYPASS_COOKIE_NAME || "ohmyphoto_human");
    const ttlMs = Number(env.TURNSTILE_BYPASS_COOKIE_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
    const clientIp = getClientIp(request);
    const secure = new URL(request.url).protocol === "https:";
    if (cookieEnabled) {
      issueBypassCookie = async () => {
        const issued = await issueHumanBypassToken(env.TURNSTILE_SECRET_KEY, clientIp, ttlMs);
        bypassCookieHeader = makeSetCookie({
          name: cookieName,
          value: issued.token,
          maxAgeSec: Math.floor(ttlMs / 1000),
          secure
        });
        setBypassCookie = true;
      };

      const __tCookie = __ompNowMs();
      const cookieToken = getCookieValue(request.headers.get("Cookie"), cookieName);
      if (cookieToken) {
        const ok = await verifyHumanBypassToken(cookieToken, env.TURNSTILE_SECRET_KEY, clientIp);
        if (ok.ok) {
          // Sliding TTL: refresh cookie.
          await issueBypassCookie();
        }
      }
      __mark('turnstile_cookie', __tCookie);
    }

    // Soft Turnstile:
    // - Only *suspicious* requests count towards the per-IP soft counter: wrong secret (403) or
    //   unknown album (404) without a Turnstile token / bypass cookie. A visitor opening a valid
    //   link never moves the counter, so a shared NAT (office, mobile carrier) or the photographer
    //   testing links does not push honest visitors into the captcha.
    // - Until the IP exceeds the threshold the request is never blocked and never waits on
    //   Turnstile verification.
    // - Once the threshold is exceeded, Turnstile (or the cookie) is required synchronously.
    // - A valid secret earns the bypass cookie right away (see below), so repeat visits from the
    //   same browser skip even the counter peek.
    if (!setBypassCookie) {
      const threshold = Number(env.TURNSTILE_SOFT_THRESHOLD) || 256;
      const windowMs = Number(env.TURNSTILE_SOFT_WINDOW_MS) || 24 * 60 * 60 * 1000;
      const __tPeek = __ompNowMs();
      const { count } = await peekTurnstileSoftCount(env, clientIp);
      __mark('turnstile_soft_peek', __tPeek);
      const enforced = count >= threshold; // require Turnstile starting from (threshold + 1)-th "bad" request

      if (enforced) {
        const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
        if (!turnstileToken) {
          return new Response("Bot verification required", { status: 403 });
        }
        const __tVerify = __ompNowMs();
        const err = await requireTurnstileOr403(request, {
          token: turnstileToken,
          secretKey: env.TURNSTILE_SECRET_KEY,
          timeoutMs: turnstileTimeoutMs,
          messageRequired: "Bot verification required",
          messageFailed: "Bot verification failed"
        });
        __mark('turnstile_verify', __tVerify);
        if (err) return err;
        // Passed the challenge: trust this browser for the cookie TTL (the secret may still be wrong).
        await issueBypassCookie();
      } else {
        // Not enforced yet: decide after the secret check whether this request counts.
        // - valid secret => never counted (see penalizeIfSuspicious)
        // - wrong secret / unknown album, no token => counted
        // - wrong secret / unknown album, token present => verified in the background, counted only on failure
        penalizeIfSuspicious = () => {
          const work = (async () => {
            if (turnstileToken) {
              const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
              try {
                const r = await verifyTurnstileRequest(request, turnstileToken, env.TURNSTILE_SECRET_KEY, turnstileTimeoutMs);
                if (r && r.success) return;
              } catch {
                // On errors/timeouts treat as unverified -> count it.
              }
            }
            await adjustTurnstileSoftCounter(env, clientIp, +1, windowMs);
          })();
          // Best-effort: never block the album response on Durable Object round-trips.
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
          else work.catch(() => null);
        };
      }
    }
    __mark('turnstile_total', __tTurnstile);
  }

  // Check if album exists and secret is valid (started above)
  const checkResult = await secretCheckPromise;
  __mark('album_secret', __tSecret);
  if (!checkResult.success) {
    // Wrong secret / unknown album: count it. A broken info.json (500) is our problem, not the visitor's.
    const st = checkResult.response.status;
    if (penalizeIfSuspicious && (st === 403 || st === 404)) penalizeIfSuspicious();
    return checkResult.response;
  }
  // Valid secret under the soft threshold: trust this browser for the cookie TTL so repeat
  // visits skip the counter peek and never hit the captcha.
  if (!setBypassCookie && penalizeIfSuspicious) {
    await issueBypassCookie();
  }
  const info = checkResult.info;
  const matchedSecret = checkResult.matchedSecret;

  // View statistics (admin only): one hit per successful open, per link. Never blocks the response.
  {
    const work = recordAlbumView(env, albumId, matchedSecret).catch(() => null);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  }

  // NO LISTING: photo list must be provided in info.json (managed via admin).
  // Entries are { name, ref }; ref addresses the shared photos/<ref>.jpg object.
  const __tFiles = __ompNowMs();
  const rawFiles = info && Array.isArray(info.files) ? info.files : null;
  if (!rawFiles) {
    return new Response("Album is missing files list in info.json", { status: 500 });
  }
  const entries = parseFileEntries(info);
  __mark('album_files_info', __tFiles);

  const __tSig = __ompNowMs();
  // `n` is not part of the signature; the image handler only uses it for Content-Disposition so
  // a saved original gets the album file name instead of the hash.
  const files = entries.map(async ({ name, ref, size }) => {
    const sig = await imageSig(albumId, ref, matchedSecret);
    const base = `/img/${encodeURIComponent(albumId)}`;
    return {
      name,
      size,
      photoUrl: `${base}/photos/${ref}?s=${sig}&n=${encodeURIComponent(name)}`,
      previewUrl: `${base}/preview/${ref}?s=${sig}`
    };
  });

  const resolvedFiles = await Promise.all(files);
  __mark('image_sig_all', __tSig);

  // Client-side ZIP download gate (the browser builds the archive from photoUrl's).
  const { available, reason, totalBytes, sizeKnown, maxFiles, maxBytes } = zipPolicy(entries, env);

  const resp = {
    albumId,
    title: String(info?.title || "OhMyPhoto"),
    files: resolvedFiles,
    zip: { available, reason, fileCount: entries.length, totalBytes, sizeKnown, maxFiles, maxBytes }
  };

  const extra = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "Server-Timing": __ompFormatServerTiming([...__timings, ['total', (__ompNowMs() - __tStart)]]),
    "X-OhMyPhoto-Index": "info_json",
    "X-OhMyPhoto-FileCount": String(entries.length),
  };
  if (setBypassCookie && bypassCookieHeader) {
    extra["Set-Cookie"] = bypassCookieHeader;
  }
  return json(resp, 200, extra);
}

