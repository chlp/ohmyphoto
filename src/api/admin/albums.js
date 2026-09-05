import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { getAlbumInfoWithSecrets, invalidateAlbumCache } from '../../utils/album.js';
import { isValidAlbumId, isValidAlbumSecret } from '../../utils/validate.js';
import { readJson } from '../../utils/http.js';
import { bytesToHex } from '../../utils/crypto.js';
import {
  albumExists,
  getFileEntries,
  getInfoJson,
  infoKey,
  listAlbumIds,
  mapLimit,
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
      secrets: r.secrets,
      fileCount: getFileEntries(r.info).length
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
 * An album is only its info.json, so a rename is one put + one delete; photos are shared and
 * addressed by content, nothing moves.
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

  if (!newAlbumId || newAlbumId === albumId) {
    await putInfoJson(env, albumId, nextInfo);
    return jsonNoStore({ albumId, title: nextTitle });
  }

  if (await albumExists(env, newAlbumId)) return conflict("Destination album already exists");
  await putInfoJson(env, newAlbumId, nextInfo);
  await env.BUCKET.delete(infoKey(albumId));
  await invalidateAlbumCache(env, albumId);
  return jsonNoStore({ albumId: newAlbumId, title: nextTitle, renamedFrom: albumId });
}

/** DELETE /api/admin/album/<albumId> — removes info.json only; shared photos are reclaimed by GC. */
export async function handleDeleteAlbum({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const existed = await albumExists(env, albumId);
  if (existed) await env.BUCKET.delete(infoKey(albumId));
  await invalidateAlbumCache(env, albumId);
  if (!existed) return notFound();
  return jsonNoStore({ deleted: true, albumId });
}
