import { json } from '../utils/response.js';
import { isValidAlbumId } from '../utils/validate.js';
import { extractSecrets } from '../utils/albumSecrets.js';

/**
 * Durable Object: caches album info.json + extracted secrets persistently.
 *
 * Instance keying: caller should use idFromName(`album:${albumId}`) to shard per album.
 *
 * Protocol (POST):
 * - { action: "get", albumId, ttlMs? } -> { ok: true, albumId, info, secrets, cached, fetchedAtMs }
 * - { action: "invalidate" } -> { ok: true }
 */
export class AlbumInfoDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mem = null; // best-effort in-instance memo to avoid repeated storage.get in same isolate
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

    const albumId = String(body.albumId || '');
    if (!isValidAlbumId(albumId)) {
      return json({ ok: false, error: 'Invalid albumId' }, 400, { 'Cache-Control': 'no-store' });
    }

    const ttlMs =
      Number(body.ttlMs) ||
      Number(this.env.ALBUM_INFO_TTL_MS) ||
      7 * 24 * 60 * 60 * 1000;

    // If we had a parse error, don't pin it for the full ttl.
    const parseErrorTtlMs =
      Number(this.env.ALBUM_INFO_PARSE_ERROR_TTL_MS) ||
      60 * 1000;

    const now = Date.now();
    const v = await this.load();

    if (v && v.albumId === albumId && Number.isFinite(v.fetchedAtMs)) {
      const ageMs = now - v.fetchedAtMs;
      const effectiveTtlMs = v.ok === false && v.status === 500 ? parseErrorTtlMs : ttlMs;
      if (ageMs >= 0 && ageMs < effectiveTtlMs) {
        return json({ ...v, cached: true }, 200, { 'Cache-Control': 'no-store' });
      }
    }

    const next = await this.refresh(albumId);
    return json({ ...next, cached: false }, 200, { 'Cache-Control': 'no-store' });
  }
}


