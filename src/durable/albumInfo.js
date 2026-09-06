import { json } from '../utils/response.js';
import { isValidAlbumId } from '../utils/validate.js';
import { extractSecrets } from '../utils/albumSecrets.js';

/**
 * Durable Object: caches album info.json + extracted secrets persistently.
 *
 * Instance keying: caller should use idFromName(`album:${albumId}`) to shard per album.
 *
 * Protocol (POST):
 * - { action: "get", albumId, ttlMs?, withStats? } -> { ok: true, albumId, info, secrets, cached, fetchedAtMs, stats? }
 *   (`stats` = the same object `stats` returns, only when `withStats` is true)
 * - { action: "invalidate" } -> { ok: true }   (cache only; view stats are kept)
 *
 * View statistics live next to the cache under a separate storage key, so invalidating the
 * cache never resets them. One "view" = one album request with a valid secret (recorded by
 * src/api/album.js in ctx.waitUntil).
 * - { action: "hit", secret } -> { ok: true }
 * - { action: "stats" } -> { ok: true, stats: { since, lastAt, total, bySecret: { <secret>: n } } }
 *   (`since` = ms timestamp of the first counted view, null when nothing was counted yet)
 * - { action: "importStats", stats } -> { ok: true }   (merge; used when an album is renamed)
 * - { action: "resetStats" } -> { ok: true }
 */
const STATS_KEY = 'stats';

export function emptyAlbumStats() {
  return { since: null, lastAt: null, total: 0, bySecret: {} };
}

/** Sum two stats objects (rename moves the old album's counters onto the new id). */
export function mergeAlbumStats(a, b) {
  const x = normalizeAlbumStats(a);
  const y = normalizeAlbumStats(b);
  const out = emptyAlbumStats();
  out.total = x.total + y.total;
  const sinces = [x.since, y.since].filter((v) => v != null);
  out.since = sinces.length ? Math.min(...sinces) : null;
  const lasts = [x.lastAt, y.lastAt].filter((v) => v != null);
  out.lastAt = lasts.length ? Math.max(...lasts) : null;
  for (const src of [x.bySecret, y.bySecret]) {
    for (const [k, v] of Object.entries(src)) out.bySecret[k] = (out.bySecret[k] || 0) + v;
  }
  return out;
}

/** Coerce anything (stored value, client payload) into a well-formed stats object. */
export function normalizeAlbumStats(v) {
  const out = emptyAlbumStats();
  if (!v || typeof v !== 'object') return out;
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.floor(Number(x)) : 0);
  out.total = num(v.total);
  out.since = Number.isFinite(Number(v.since)) && v.since != null ? Number(v.since) : null;
  out.lastAt = Number.isFinite(Number(v.lastAt)) && v.lastAt != null ? Number(v.lastAt) : null;
  if (v.bySecret && typeof v.bySecret === 'object') {
    for (const [k, n] of Object.entries(v.bySecret)) {
      const c = num(n);
      if (k && c > 0) out.bySecret[k] = c;
    }
  }
  return out;
}

export class AlbumInfoDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mem = null; // best-effort in-instance memo to avoid repeated storage.get in same isolate
    this.statsMem = null; // same for the view counters
  }

  async loadStats() {
    if (this.statsMem) return this.statsMem;
    this.statsMem = normalizeAlbumStats(await this.state.storage.get(STATS_KEY));
    return this.statsMem;
  }

  async saveStats(stats) {
    this.statsMem = stats;
    await this.state.storage.put(STATS_KEY, stats);
  }

  async hit(secret) {
    const stats = await this.loadStats();
    const now = Date.now();
    if (stats.since == null) stats.since = now;
    stats.lastAt = now;
    stats.total += 1;
    if (secret) stats.bySecret[secret] = (stats.bySecret[secret] || 0) + 1;
    await this.saveStats(stats);
  }


  async load() {
    if (this.mem) return this.mem;
    this.mem = (await this.state.storage.get('v')) || null;
    return this.mem;
  }

  async save(v) {
    this.mem = v;
    await this.state.storage.put('v', v);
  }

  async invalidate() {
    this.mem = null;
    await this.state.storage.delete('v');
  }

  async refresh(albumId) {
    const key = `albums/${albumId}/info.json`;
    const obj = await this.env.BUCKET.get(key);
    if (!obj) {
      const v = { ok: false, status: 404, albumId, fetchedAtMs: Date.now() };
      await this.save(v);
      return v;
    }

    let info;
    try {
      info = await obj.json();
    } catch {
      const v = { ok: false, status: 500, albumId, fetchedAtMs: Date.now() };
      await this.save(v);
      return v;
    }

    const secrets = extractSecrets(info);
    const v = { ok: true, albumId, info, secrets, fetchedAtMs: Date.now() };
    await this.save(v);
    return v;
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || 'get');

    if (action === 'invalidate') {
      await this.invalidate();
      return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'hit') {
      await this.hit(String(body.secret || ''));
      return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'stats') {
      return json({ ok: true, stats: await this.loadStats() }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'importStats') {
      await this.saveStats(mergeAlbumStats(await this.loadStats(), body.stats));
      return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    }
    if (action === 'resetStats') {
      this.statsMem = null;
      await this.state.storage.delete(STATS_KEY);
      return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    }

    const albumId = String(body.albumId || '');
    if (!isValidAlbumId(albumId)) {
      return json({ ok: false, error: 'Invalid albumId' }, 400, { 'Cache-Control': 'no-store' });
    }

    const ttlMs =
      Number(body.ttlMs) ||
      Number(this.env.ALBUM_INFO_TTL_MS) ||
      7 * 24 * 60 * 60 * 1000;

    // Negative results get shorter TTLs: a missing album may be created any moment
    // (e.g. uploaded directly to R2), and a parse error is usually fixed quickly.
    const notFoundTtlMs =
      Number(this.env.ALBUM_INFO_NOT_FOUND_TTL_MS) ||
      60 * 60 * 1000;
    const parseErrorTtlMs =
      Number(this.env.ALBUM_INFO_PARSE_ERROR_TTL_MS) ||
      60 * 1000;

    const now = Date.now();
    const v = await this.load();

    if (v && v.albumId === albumId && Number.isFinite(v.fetchedAtMs)) {
      const ageMs = now - v.fetchedAtMs;
      let effectiveTtlMs = ttlMs;
      if (v.ok === false) effectiveTtlMs = v.status === 404 ? notFoundTtlMs : parseErrorTtlMs;
      if (ageMs >= 0 && ageMs < effectiveTtlMs) {
        return json({ ...v, cached: true, ...(await this.maybeStats(body)) }, 200, { 'Cache-Control': 'no-store' });
      }
    }

    const next = await this.refresh(albumId);
    return json({ ...next, cached: false, ...(await this.maybeStats(body)) }, 200, { 'Cache-Control': 'no-store' });
  }

  async maybeStats(body) {
    return body && body.withStats ? { stats: await this.loadStats() } : {};
  }
}


