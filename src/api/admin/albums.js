import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { getAlbumInfoWithSecrets, getAlbumStats, invalidateAlbumCache, moveAlbumStats, resetAlbumStats } from '../../utils/album.js';
import { isValidAlbumId, isValidAlbumSecret, isStrongAlbumSecret, MIN_ALBUM_SECRET_LENGTH } from '../../utils/validate.js';
import { extractSecrets } from '../../utils/albumSecrets.js';
import { readJson } from '../../utils/http.js';
import { randomHex } from '../../utils/crypto.js';
import {
  albumExists,
  getFileEntries,
  getInfoJson,
  infoKey,
  listAlbumIds,
  mapLimit,
  normalizeSecretsToObject,
  putInfoJson,
  updateInfoJson
} from './infoStore.js';
import { moveAlbumToTrash } from './trash.js';

const DEFAULT_TITLE = "OhMyPhoto";

/** 10 random bytes = 20 hex chars (80 bits); see MIN_ALBUM_SECRET_LENGTH for why not shorter. */
export function generateAlbumSecret() {
  return randomHex(10);
}

/**
 * GET /api/admin/albums?cursor=<c>
 * One page of albums (PAGE_ALBUMS); the client follows `cursor` until it is null.
 */
export async function handleListAlbums({ env, url }) {
  const { ids, cursor } = await listAlbumIds(env, { cursor: url.searchParams.get("cursor") || undefined });
  const loaded = await mapLimit(ids, 16, async (albumId) => {
    // withStats rides on the same DO call, so the page stays at 1 list + PAGE_ALBUMS subrequests.
    const r = await getAlbumInfoWithSecrets(albumId, env, { withStats: true });
    if (!r.ok) return null; // folder without a readable info.json
    return {
      albumId,
      title: String(r.info?.title || DEFAULT_TITLE),
      secretCount: r.secrets.length,
      secrets: r.secrets,
      fileCount: getFileEntries(r.info).length,
      views: r.stats || null
    };
  });
  return jsonNoStore({ albums: loaded.filter(Boolean), cursor, done: cursor === null });
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
  if (secretIn && !isStrongAlbumSecret(secretIn)) return badRequest(`Secret too short (min ${MIN_ALBUM_SECRET_LENGTH} chars)`);
  if (await albumExists(env, albumId)) return conflict("Album already exists");

  const secret = secretIn || generateAlbumSecret();
  await putInfoJson(env, albumId, { title, secrets: { [secret]: {} }, files: [] });
  // Return secret as a convenience for the UI/caller (still admin-protected).
  return jsonNoStore({ albumId, title, secret });
}

/**
 * Validate a secrets list from the client. Every secret must be fragment-safe; secrets that
 * are not already on the album must also meet the minimum length (old short ones may stay).
 * @returns {Response|null} 400 response or null
 */
function validateSecretsList(secretsList, existingSecrets) {
  const existing = new Set(existingSecrets);
  for (const raw of secretsList) {
    const s = String(raw || "").trim();
    if (!s) continue;
    if (!isValidAlbumSecret(s)) return badRequest(`Invalid secret: ${s.slice(0, 32)}`);
    if (!existing.has(s) && !isStrongAlbumSecret(s)) return badRequest(`Secret too short (min ${MIN_ALBUM_SECRET_LENGTH} chars): ${s}`);
  }
  return null;
}

/**
 * PUT /api/admin/album/<albumId>
 * Body: { title?, secrets?: string[], newAlbumId? }
 * An album is only its info.json, so a rename is one put + one delete; photos are shared and
 * addressed by content, nothing moves.
 */
export async function handleUpdateAlbum({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");

  const newAlbumId = body.newAlbumId != null ? String(body.newAlbumId || "").trim() : "";
  if (newAlbumId && !isValidAlbumId(newAlbumId)) return badRequest("Invalid newAlbumId");
  const secretsList = Array.isArray(body.secrets) ? body.secrets : null;

  const applyChanges = (existingInfo) => {
    if (secretsList) {
      const err = validateSecretsList(secretsList, extractSecrets(existingInfo));
      if (err) return { response: err };
    }
    const nextTitle = body.title != null ? String(body.title || DEFAULT_TITLE) : String(existingInfo.title || DEFAULT_TITLE);
    const nextSecretsObj = secretsList
      ? normalizeSecretsToObject(secretsList)
      : (existingInfo.secrets && typeof existingInfo.secrets === "object" ? existingInfo.secrets : {});
    return { info: { ...existingInfo, title: nextTitle, secrets: nextSecretsObj }, result: { title: nextTitle } };
  };

  if (!newAlbumId || newAlbumId === albumId) {
    const r = await updateInfoJson(env, albumId, applyChanges);
    if (!r.ok) return r.response;
    return jsonNoStore({ albumId, title: r.result.title });
  }

  const existingInfo = await getInfoJson(env, albumId);
  if (!existingInfo) return notFound();
  const next = applyChanges(existingInfo);
  if (next.response) return next.response;
  if (await albumExists(env, newAlbumId)) return conflict("Destination album already exists");
  await putInfoJson(env, newAlbumId, next.info);
  await env.BUCKET.delete(infoKey(albumId));
  await invalidateAlbumCache(env, albumId);
  await moveAlbumStats(env, albumId, newAlbumId);
  return jsonNoStore({ albumId: newAlbumId, title: next.result.title, renamedFrom: albumId });
}

/**
 * GET /api/admin/album/<albumId>/stats
 * View counters kept by AlbumInfoDO: { since, lastAt, total, bySecret }. `bySecret` may contain
 * secrets that were since removed from the album; the UI shows them as "removed links".
 */
export async function handleAlbumStats({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  if (!(await albumExists(env, albumId))) return notFound();
  return jsonNoStore({ albumId, ...(await getAlbumStats(env, albumId)) });
}

/** DELETE /api/admin/album/<albumId>/stats — start counting from zero (also clears `since`). */
export async function handleResetAlbumStats({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  await resetAlbumStats(env, albumId);
  return jsonNoStore({ albumId, reset: true });
}

/**
 * DELETE /api/admin/album/<albumId>
 * Removes info.json after copying it to trash/ (see trash.js); shared photos are reclaimed by GC.
 */
export async function handleDeleteAlbum({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const trashKey = await moveAlbumToTrash(env, albumId);
  await invalidateAlbumCache(env, albumId);
  if (!trashKey) return notFound();
  return jsonNoStore({ deleted: true, albumId, trashKey });
}
