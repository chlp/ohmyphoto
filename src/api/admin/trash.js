import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { isValidAlbumId } from '../../utils/validate.js';
import { readJson } from '../../utils/http.js';
import { albumExists, infoKey, putInfoJson } from './infoStore.js';

/**
 * Trash for album metadata. An album is only its info.json, so deleting one by accident loses
 * the name -> photo mapping while the (content-addressed) photos stay around as anonymous
 * hashes. Deleting therefore copies info.json to
 *   trash/albums/<albumId>/<ISO timestamp>.json
 * before removing it. Trash is metadata only: GC does not treat refs listed in trash as
 * referenced, so a restored album may point at photos that were collected in the meantime
 * (verify-files drops those entries). Trash objects are kept until restored or deleted here.
 */

export const TRASH_PREFIX = "trash/albums/";
const TRASH_LIST_LIMIT = 1000;
const TRASH_KEY_RE = /^trash\/albums\/([a-zA-Z0-9_.-]{1,128})\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

function trashKey(albumId, now = new Date()) {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${TRASH_PREFIX}${albumId}/${ts}.json`;
}

/** Parse a trash key into { albumId, deletedAt }; null if it is not one of ours. */
export function parseTrashKey(key) {
  const m = String(key || "").match(TRASH_KEY_RE);
  if (!m) return null;
  const iso = m[2].replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
  return { albumId: m[1], deletedAt: iso };
}

/**
 * Copy albums/<id>/info.json into trash/ and delete the original (3 R2 calls).
 * @returns {Promise<string|null>} the trash key, or null if the album did not exist
 */
export async function moveAlbumToTrash(env, albumId) {
  const obj = await env.BUCKET.get(infoKey(albumId));
  if (!obj) return null;
  const key = trashKey(albumId);
  await env.BUCKET.put(key, obj.body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { albumId, deletedAt: new Date().toISOString() }
  });
  await env.BUCKET.delete(infoKey(albumId));
  return key;
}

/** GET /api/admin/trash — up to 1000 trashed albums, newest first (one list call, no reads). */
export async function handleListTrash({ env }) {
  const listed = await env.BUCKET.list({ prefix: TRASH_PREFIX, limit: TRASH_LIST_LIMIT });
  const items = [];
  for (const o of listed.objects) {
    const parsed = parseTrashKey(o.key);
    if (!parsed) continue;
    items.push({ key: o.key, albumId: parsed.albumId, deletedAt: parsed.deletedAt, size: o.size });
  }
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  return jsonNoStore({ items, truncated: Boolean(listed.truncated) });
}

/**
 * POST /api/admin/trash/restore — body { key, albumId? }
 * Puts the trashed info.json back as albums/<albumId>/info.json (the original ID unless
 * `albumId` is given) and removes the trash object. 409 if that album exists.
 */
export async function handleRestoreTrash({ request, env }) {
  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");
  const key = String(body.key || "");
  const parsed = parseTrashKey(key);
  if (!parsed) return badRequest("Invalid trash key");
  const albumId = body.albumId != null && String(body.albumId).trim() ? String(body.albumId).trim() : parsed.albumId;
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

  const obj = await env.BUCKET.get(key);
  if (!obj) return notFound();
  let info;
  try {
    info = await obj.json();
  } catch {
    return badRequest("Trashed info.json is not valid JSON");
  }
  if (await albumExists(env, albumId)) return conflict("Album already exists");

  await putInfoJson(env, albumId, info);
  await env.BUCKET.delete(key);
  return jsonNoStore({ restored: true, albumId, key });
}

/** DELETE /api/admin/trash/<key> — drop one trash object for good. */
export async function handleDeleteTrash({ env, params: [key] }) {
  if (!parseTrashKey(key)) return badRequest("Invalid trash key");
  const existed = !!(await env.BUCKET.head(key));
  if (!existed) return notFound();
  await env.BUCKET.delete(key);
  return jsonNoStore({ deleted: true, key });
}
