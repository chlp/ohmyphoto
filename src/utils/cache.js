/**
 * Very small in-memory TTL cache for Workers (works in production and wrangler dev).
 * Note: cache is per-isolate (best-effort), not shared globally.
 */
export function createTtlCache({ maxEntries = 1000, ttlMs = 60_000 } = {}) {
  const map = new Map(); // key -> { value, expiresAt }

  function prune() {
    const now = Date.now();
    // Drop expired first
    for (const [k, v] of map) {
      if (v.expiresAt <= now) map.delete(k);
      else break; // insertion order: stop early most of the time
    }
    // Enforce size (drop oldest)
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  return {
    get(key) {
      const v = map.get(key);
      if (!v) return undefined;
      if (v.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return v.value;
    },
    set(key, value, customTtlMs) {
      const t = typeof customTtlMs === "number" ? customTtlMs : ttlMs;
      // refresh recency
      if (map.has(key)) map.delete(key);
      map.set(key, { value, expiresAt: Date.now() + t });
      prune();
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
}


