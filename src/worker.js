import { route } from './router.js';
import { enforceRateLimit } from './utils/rateLimit.js';
export { RateLimiterDO } from './durable/rateLimiter.js';
export { AlbumIndexDO } from './durable/albumIndex.js';

export default {
  async fetch(request, env) {
    const debug = request.headers.get('X-OhMyPhoto-Debug') === '1';
    const startedAt = Date.now();

    const withDebugHeaders = (resp, { rateLimitMs = null, routeMs = null, workerTotalMs = null } = {}) => {
      if (!debug) return resp;
      const headers = new Headers(resp.headers);
      const existing = headers.get('Server-Timing');
      const parts = [];
      if (Number.isFinite(rateLimitMs)) parts.push(`rate_limit;dur=${Math.max(0, Math.round(rateLimitMs))}`);
      if (Number.isFinite(routeMs)) parts.push(`route;dur=${Math.max(0, Math.round(routeMs))}`);
      if (Number.isFinite(workerTotalMs)) parts.push(`worker_total;dur=${Math.max(0, Math.round(workerTotalMs))}`);
      if (parts.length) headers.set('Server-Timing', existing ? `${existing}, ${parts.join(', ')}` : parts.join(', '));
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    };

    const tRl = Date.now();
    const limited = await enforceRateLimit(request, env);
    const rateLimitMs = Date.now() - tRl;
    if (limited) {
      return withDebugHeaders(limited, { rateLimitMs, workerTotalMs: Date.now() - startedAt });
    }

    const tRoute = Date.now();
    const resp = await route(request, env);
    const routeMs = Date.now() - tRoute;
    return withDebugHeaders(resp, { rateLimitMs, routeMs, workerTotalMs: Date.now() - startedAt });
  }
};
