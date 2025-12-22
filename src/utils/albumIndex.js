import { isValidAlbumId } from "./validate.js";

/**
 * Get cached album index (photo names + hasPreview) from Durable Object.
 * Falls back to null if binding is missing.
 *
 * @returns {Promise<{ok:true, files:Array<{name:string, hasPreview:boolean}>, cached:boolean, fetchedAtMs:number} | {ok:false, status:number, error:string} | null>}
 */
export async function getAlbumIndex(env, albumId, { ttlMs } = {}) {
  if (!env || !env.ALBUM_INDEXER) return null;
  if (!isValidAlbumId(albumId)) return { ok: false, status: 400, error: 'Invalid albumId' };

  const stub = env.ALBUM_INDEXER.get(env.ALBUM_INDEXER.idFromName(`album:${albumId}`));
  const r = await stub.fetch('https://album-index/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', albumId, ...(ttlMs ? { ttlMs } : {}) })
  });
  if (!r.ok) return { ok: false, status: r.status, error: 'Album indexer error' };

  const data = await r.json().catch(() => null);
  if (!data || data.ok !== true || !Array.isArray(data.files)) {
    return { ok: false, status: 502, error: 'Bad indexer response' };
  }
  return { ok: true, files: data.files, cached: !!data.cached, fetchedAtMs: Number(data.fetchedAtMs) || 0 };
}

/**
 * Explicitly invalidate cached album index in Durable Object.
 * No-op if binding is missing.
 */
export async function invalidateAlbumIndex(env, albumId) {
  if (!env || !env.ALBUM_INDEXER) return;
  if (!isValidAlbumId(albumId)) return;
  const stub = env.ALBUM_INDEXER.get(env.ALBUM_INDEXER.idFromName(`album:${albumId}`));
  // best-effort
  await stub.fetch('https://album-index/invalidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'invalidate' })
  }).catch(() => null);
}


