import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { getAlbumInfoWithSecrets, invalidateAlbumCache } from '../../utils/album.js';
import { isValidAlbumId, isValidAlbumSecret } from '../../utils/validate.js';
import { copyObject, listAllKeys } from '../../utils/r2.js';
import { readJson } from '../../utils/http.js';
import { bytesToHex } from '../../utils/crypto.js';
import {
  albumExists,
  getInfoJson,
  infoKey,
  listAlbumIds,
  normalizeSecretsToObject,
  putInfoJson
} from './infoStore.js';

const DEFAULT_TITLE = "OhMyPhoto";

function generateAlbumSecret6() {
  // 3 bytes => 6 hex chars
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Move album objects (photos + previews) from one prefix to another, one object at a time
 * (copy, then delete). Sequential + bounded per call so a single Worker invocation stays
 * well under the subrequest limit; the caller repeats the request until `done`.
 * info.json is NOT moved here — it is written last by the caller so that a partially
 * moved album can always be resumed (old info.json present, new one absent).
 */
export async function moveAlbumObjects(env, oldAlbumId, newAlbumId, maxObjects) {
  const oldPrefix = `albums/${oldAlbumId}/`;
  const newPrefix = `albums/${newAlbumId}/`;
  const oldInfo = infoKey(oldAlbumId);

  const keys = (await listAllKeys(env.BUCKET, oldPrefix)).filter((k) => k !== oldInfo);
  const budget = Math.max(1, Number(maxObjects) || 200);

  let moved = 0;
  for (const key of keys) {
    if (moved >= budget) break;
    const newKey = newPrefix + key.substring(oldPrefix.length);
    await copyObject(env.BUCKET, key, newKey);
    await env.BUCKET.delete(key);
    moved += 1;
  }
  const remaining = keys.length - moved;
  return { done: remaining === 0, moved, remaining };
}

export async function deleteAlbumObjects(env, albumId) {
  const keys = await listAllKeys(env.BUCKET, `albums/${albumId}/`);
  if (!keys.length) return false;
  for (let i = 0; i < keys.length; i += 100) {
    await env.BUCKET.delete(keys.slice(i, i + 100));
  }
  return true;
}

/** GET /api/admin/albums */
export async function handleListAlbums({ env }) {
  const ids = await listAlbumIds(env);
  const loaded = await mapLimit(ids, 16, async (albumId) => {
    const r = await getAlbumInfoWithSecrets(albumId, env);
    if (!r.ok) return null; // folder without a readable info.json
    return {
      albumId,
      title: String(r.info?.title || DEFAULT_TITLE),
      secretCount: r.secrets.length,
      secrets: r.secrets
    };
  });
  return jsonNoStore({ albums: loaded.filter(Boolean) });
}

/** POST /api/admin/album */
export async function handleCreateAlbum({ request, env }) {
  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");
  const albumId = String(body.albumId || "").trim();
  const title = String(body.title || DEFAULT_TITLE);
  const secretIn = body.secret != null ? String(body.secret || "").trim() : "";

  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  if (secretIn && !isValidAlbumSecret(secretIn)) return badRequest("Invalid secret");
  if (await albumExists(env, albumId)) return conflict("Album already exists");

  const secret = secretIn || generateAlbumSecret6();
  await putInfoJson(env, albumId, { title, secrets: { [secret]: {} }, files: [] });
  // Return secret as a convenience for the UI/caller (still admin-protected).
  return jsonNoStore({ albumId, title, secret });
}

/**
 * PUT /api/admin/album/<albumId>
 * Body: { title?, secrets?: string[], newAlbumId? }
 * Rename is chunked: while objects remain the response is
 * { albumId, renameInProgress: true, moved, remaining } and the client must repeat the call.
 */
export async function handleUpdateAlbum({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");

  const newAlbumId = body.newAlbumId != null ? String(body.newAlbumId || "").trim() : "";
  if (newAlbumId && !isValidAlbumId(newAlbumId)) return badRequest("Invalid newAlbumId");

  const existingInfo = await getInfoJson(env, albumId);
  if (!existingInfo) return notFound();

  const nextTitle = body.title != null ? String(body.title || DEFAULT_TITLE) : String(existingInfo.title || DEFAULT_TITLE);
  const secretsList = Array.isArray(body.secrets) ? body.secrets : null;
  const nextSecretsObj = secretsList
    ? normalizeSecretsToObject(secretsList)
    : (existingInfo.secrets && typeof existingInfo.secrets === "object" ? existingInfo.secrets : {});

  const nextInfo = { ...existingInfo, title: nextTitle, secrets: nextSecretsObj };
  delete nextInfo.secret; // keep one canonical format

  if (!newAlbumId || newAlbumId === albumId) {
    await putInfoJson(env, albumId, nextInfo);
    return jsonNoStore({ albumId, title: nextTitle });
  }

  // Rename: destination is "taken" only if its info.json exists (written last, so a
  // previously interrupted rename can be resumed by repeating the same request).
  if (await albumExists(env, newAlbumId)) return conflict("Destination album already exists");

  const progress = await moveAlbumObjects(env, albumId, newAlbumId, Number(env.ALBUM_RENAME_BATCH) || 200);
  if (!progress.done) {
    await invalidateAlbumCache(env, albumId); // gallery must not serve stale file list
    return jsonNoStore({ albumId, renameInProgress: true, moved: progress.moved, remaining: progress.remaining });
  }

  await env.BUCKET.put(infoKey(newAlbumId), JSON.stringify(nextInfo, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  await env.BUCKET.delete(infoKey(albumId));
  await Promise.all([invalidateAlbumCache(env, albumId), invalidateAlbumCache(env, newAlbumId)]);
  return jsonNoStore({ albumId: newAlbumId, title: nextTitle, renamedFrom: albumId });
}

/** DELETE /api/admin/album/<albumId> */
export async function handleDeleteAlbum({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const existed = await deleteAlbumObjects(env, albumId);
  await invalidateAlbumCache(env, albumId);
  if (!existed) return notFound();
  return jsonNoStore({ deleted: true, albumId });
}
