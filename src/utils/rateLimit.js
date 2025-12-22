function truthyEnv(v) {
  const s = String(v || '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

function getBucketConfig(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Avoid limiting preflight
  if (request.method === 'OPTIONS') return null;

  if (path === '/api/admin/session' && request.method === 'POST') {
    return { bucket: 'admin_session', limit: 10, windowMs: 10 * 60 * 1000 };
  }
  if (path.startsWith('/api/admin/')) {
    return { bucket: 'admin_api', limit: 300, windowMs: 5 * 60 * 1000 };
  }
  if (path.startsWith('/api/album/')) {
    return { bucket: 'album_api', limit: 120, windowMs: 60 * 1000 };
  }
  if (path.startsWith('/img/')) {
    // Images can be bursty; keep this generous.
    return { bucket: 'img', limit: 1200, windowMs: 5 * 60 * 1000 };
  }

  // Default for any other worker-handled route
  return { bucket: 'other', limit: 600, windowMs: 5 * 60 * 1000 };
}

function rateLimitHeaders({ limit, remaining, resetAtMs }) {
  const resetSec = Math.max(0, Math.ceil((Number(resetAtMs) - Date.now()) / 1000));
  return {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(resetSec),
    'Retry-After': String(resetSec),
    'Cache-Control': 'no-store'
  };
}

/**
 * Best-effort global rate limit via Durable Object.
 * Returns `null` if allowed, or a Response(429) if blocked.
 */
export async function enforceRateLimit(request, env) {
  if (truthyEnv(env.RATE_LIMIT_DISABLED)) return null;
  if (!env || !env.RATE_LIMITER) return null;

  const cfg = getBucketConfig(request);
  if (!cfg) return null;

  const ip = getClientIp(request);
  const key = `${cfg.bucket}:${ip}`;

  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
  const r = await stub.fetch('https://rate-limiter/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: cfg.limit, windowMs: cfg.windowMs })
  });

  if (!r.ok) {
    // If limiter misbehaves, fail-open (avoid taking the whole app down)
    return null;
  }

  const data = await r.json().catch(() => null);
  if (!data || data.allowed !== false) return null;

  const headers = rateLimitHeaders({
    limit: data.limit ?? cfg.limit,
    remaining: data.remaining ?? 0,
    resetAtMs: data.resetAtMs ?? (Date.now() + cfg.windowMs)
  });

  return new Response('Too Many Requests', { status: 429, headers });
}


