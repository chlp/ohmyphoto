import { route } from './router.js';
import { enforceRateLimit } from './utils/rateLimit.js';
export { RateLimiterDO } from './durable/rateLimiter.js';
export { AlbumIndexDO } from './durable/albumIndex.js';

export default {
  async fetch(request, env) {
    const limited = await enforceRateLimit(request, env);
    if (limited) {
      return limited;
    }

    return await route(request, env);
  }
};
