import { getClientIp } from './http.js';

function truthyEnv(v) {
  const s = String(v || '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Rate-limit buckets.
 *
 * Two mechanisms:
 * - `binding`: Cloudflare native Rate Limiting binding (`[[ratelimits]]` in wrangler.toml).
 *   Cheap, no Durable Object round-trip. Native periods are limited to 10s or 60s, so
 *   all native buckets use a 60s window. `fallback` describes the equivalent limit for the
 *   Durable Object path when the binding is not configured (e.g. older wrangler / tests).
 * - `durable`: RateLimiterDO. Used where a long window matters (admin login brute force).
 */
const BUCKETS = {
  admin_session: { durable: { limit: 10, windowMs: 10 * 60 * 1000 } },
  admin_api: { binding: 'RL_ADMIN_API', fallback: { limit: 60, windowMs: 60 * 1000 } },
  album_api: { binding: 'RL_ALBUM_API', fallback: { limit: 120, windowMs: 60 * 1000 } },
  img: { binding: 'RL_IMG', fallback: { limit: 300, windowMs: 60 * 1000 } },
  other: { binding: 'RL_OTHER', fallback: { limit: 120, windowMs: 60 * 1000 } }
};

export function getBucketName(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Avoid limiting preflight
  if (request.method === 'OPTIONS') return null;

  if (path === '/api/admin/session' && request.method === 'POST') return 'admin_session';
  if (path.startsWith('/api/admin/')) return 'admin_api';
  if (path.startsWith('/api/album/')) return 'album_api';
  if (path.startsWith('/img/')) return 'img';
  return 'other';
}

function tooManyRequests({ limit, remaining, resetAtMs }) {
  const resetSec = Math.max(1, Math.ceil((Number(resetAtMs) - Date.now()) / 1000));
  return new Response('Too Many Requests', {
    status: 429,
    headers: {
      'RateLimit-Limit': String(limit),
      'RateLimit-Remaining': String(remaining),
      'RateLimit-Reset': String(resetSec),
      'Retry-After': String(resetSec),
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * Native Rate Limiting binding. Returns true when allowed, false when blocked,
 * null when the binding is unavailable or errored (caller falls back / fails open).
 */
async function checkNative(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return null;
  try {
    const r = await binding.limit({ key });
    return r && r.success === false ? false : true;
  } catch {
    return null;
  }
}

/**
 * Durable Object limiter. Returns null when allowed or on any failure (fail-open),
 * otherwise a 429 Response.
 */
async function checkDurable(env, bucket, ip, { limit, windowMs }) {
  if (!env.RATE_LIMITER) return null;
  const key = `${bucket}:${ip}`;
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  // Best-effort timeout (DO fetch can't be aborted, but we can stop awaiting).
  const timeoutMs = Number(env.RATE_LIMIT_TIMEOUT_MS) || 500;
  const r = await Promise.race([
    stub.fetch('https://rate-limiter/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, windowMs })
    }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);

  if (!r || !r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || data.allowed !== false) return null;

  return tooManyRequests({
    limit: data.limit ?? limit,
    remaining: data.remaining ?? 0,
    resetAtMs: data.resetAtMs ?? (Date.now() + windowMs)
  });
}

/**
 * Best-effort per-IP rate limit.
 * Returns `null` if allowed, or a Response(429) if blocked.
 */
export async function enforceRateLimit(request, env) {
  if (!env || truthyEnv(env.RATE_LIMIT_DISABLED)) return null;

  const bucket = getBucketName(request);
  if (!bucket) return null;
  const cfg = BUCKETS[bucket];
  const ip = getClientIp(request);

  if (cfg.binding) {
    const allowed = await checkNative(env[cfg.binding], ip);
    if (allowed === true) return null;
    if (allowed === false) {
      return tooManyRequests({ limit: cfg.fallback.limit, remaining: 0, resetAtMs: Date.now() + cfg.fallback.windowMs });
    }
    // binding missing: fall back to the Durable Object with equivalent limits
    return checkDurable(env, bucket, ip, cfg.fallback);
  }

  return checkDurable(env, bucket, ip, cfg.durable);
}
