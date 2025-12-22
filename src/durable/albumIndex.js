import { json } from '../utils/response.js';

function isValidAlbumId(albumId) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(albumId || ""));
}

async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor = undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.cursor;
  } while (cursor);
  return keys;
}

/**
 * Durable Object: caches album index (photo names + whether preview exists).
 *
 * Instance keying: caller should use idFromName(`album:${albumId}`) to shard per album.
 *
 * Protocol (POST):
 * - { action: "get", albumId, ttlMs? } -> { ok: true, albumId, files: [{name, hasPreview}], cached: boolean, fetchedAtMs }
 * - { action: "invalidate" } -> { ok: true }
 */
export class AlbumIndexDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mem = null; // { albumId, files, fetchedAtMs }
  }

  async load() {
    if (this.mem) return this.mem;
    this.mem = (await this.state.storage.get('v')) || null;
    return this.mem;
  }

  async invalidate() {
    this.mem = null;
    await this.state.storage.delete('v');
  }

  async refresh(albumId) {
    const photosPrefix = `albums/${albumId}/photos/`;
    const previewPrefix = `albums/${albumId}/preview/`;

    const [photoKeys, previewKeys] = await Promise.all([
      listAllKeys(this.env, photosPrefix),
      listAllKeys(this.env, previewPrefix)
    ]);

    const photoNames = photoKeys
      .filter((k) => k !== photosPrefix)
      .map((k) => k.substring(photosPrefix.length))
      .sort((a, b) => a.localeCompare(b));

    const previewSet = new Set(
      previewKeys
        .filter((k) => k !== previewPrefix)
        .map((k) => k.substring(previewPrefix.length))
    );

    const files = photoNames.map((name) => ({ name, hasPreview: previewSet.has(name) }));
    const v = { albumId, files, fetchedAtMs: Date.now() };
    this.mem = v;
    await this.state.storage.put('v', v);
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
      Number(this.env.ALBUM_INDEX_TTL_MS) ||
      60_000;

    const now = Date.now();
    const v = await this.load();
    if (
      v &&
      v.albumId === albumId &&
      Number.isFinite(v.fetchedAtMs) &&
      (now - v.fetchedAtMs) < ttlMs &&
      Array.isArray(v.files)
    ) {
      return json({ ok: true, albumId, files: v.files, cached: true, fetchedAtMs: v.fetchedAtMs }, 200, { 'Cache-Control': 'no-store' });
    }

    const next = await this.refresh(albumId);
    return json({ ok: true, albumId, files: next.files, cached: false, fetchedAtMs: next.fetchedAtMs }, 200, { 'Cache-Control': 'no-store' });
  }
}


