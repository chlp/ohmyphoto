import { json } from '../utils/response.js';

/**
 * Durable Object rate limiter.
 * One instance should represent one (bucket + IP) key via idFromName.
 *
 * Protocol: POST body { limit: number, windowMs: number }
 * Response: { allowed, limit, remaining, resetAtMs }
 */
export class RateLimiterDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mem = null; // { count, resetAtMs }
  }

  async load() {
    if (this.mem) return this.mem;
    this.mem = (await this.state.storage.get('v')) || { count: 0, resetAtMs: 0 };
    return this.mem;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.json().catch(() => ({}));
    const limit = Number(body.limit);
    const windowMs = Number(body.windowMs);

    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      return json({ error: 'Invalid limit/windowMs' }, 400);
    }

    const now = Date.now();
    const v = await this.load();

    if (!v.resetAtMs || now >= v.resetAtMs) {
      v.count = 0;
      v.resetAtMs = now + windowMs;
    }

    v.count += 1;

    const allowed = v.count <= limit;
    const remaining = Math.max(0, limit - v.count);

    await this.state.storage.put('v', v);

    return json(
      {
        allowed,
        limit,
        remaining,
        resetAtMs: v.resetAtMs
      },
      200,
      { 'Cache-Control': 'no-store' }
    );
  }
}


