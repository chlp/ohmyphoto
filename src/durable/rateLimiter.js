import { json } from '../utils/response.js';

/**
 * Durable Object rate limiter.
 * One instance should represent one (bucket + IP) key via idFromName.
 *
 * Protocol (POST):
 * - default action "check": body { limit: number, windowMs: number } -> { allowed, limit, remaining, resetAtMs }
 * - action "reset": body { action: "reset", windowMs?: number } -> { ok: true, resetAtMs }
 * - action "peek": body { action: "peek" } -> { ok: true, count, resetAtMs }
 * - action "adjust": body { action: "adjust", delta: number, windowMs?: number } -> { ok: true, count, resetAtMs }
 * Response: { allowed, limit, remaining, resetAtMs }
 */
export class RateLimiterDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Default "check" shape: { count, resetAtMs }
    this.mem = null;
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
    const action = String(body.action || 'check');

    if (action === 'reset') {
      const now = Date.now();
      const windowMs = Number(body.windowMs);
      const v = await this.load();
      v.count = 0;
      v.resetAtMs = Number.isFinite(windowMs) && windowMs > 0 ? (now + windowMs) : 0;
      await this.state.storage.put('v', v);
      return json({ ok: true, resetAtMs: v.resetAtMs }, 200, { 'Cache-Control': 'no-store' });
    }

    if (action === 'peek') {
      const now = Date.now();
      const v = await this.load();
      const resetAtMs = Number(v.resetAtMs) || 0;
      const expired = resetAtMs > 0 && now >= resetAtMs;
      const count = expired ? 0 : (Number(v.count) || 0);
      return json({ ok: true, count, resetAtMs: expired ? 0 : resetAtMs }, 200, { 'Cache-Control': 'no-store' });
    }

    if (action === 'adjust') {
      const now = Date.now();
      const delta = Number(body.delta);
      const windowMs = Number(body.windowMs);
      if (!Number.isFinite(delta)) {
        return json({ ok: false, error: 'Invalid delta' }, 400, { 'Cache-Control': 'no-store' });
      }
      const v = await this.load();

      // If the window expired, treat current count as 0 (do not resurrect old counters).
      if (v.resetAtMs && now >= v.resetAtMs) {
        v.count = 0;
        v.resetAtMs = 0;
      }
      // Optionally set a window if none exists (useful when adjusting early in a new window).
      if ((!v.resetAtMs || v.resetAtMs <= 0) && Number.isFinite(windowMs) && windowMs > 0) {
        v.resetAtMs = now + windowMs;
      }

      const next = (Number(v.count) || 0) + delta;
      v.count = Math.max(0, next);
      await this.state.storage.put('v', v);
      return json({ ok: true, count: v.count, resetAtMs: v.resetAtMs }, 200, { 'Cache-Control': 'no-store' });
    }

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


