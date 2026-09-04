import { invalidateAlbumCache } from '../../utils/album.js';
import { isValidAlbumId, isValidPhotoFileName } from '../../utils/validate.js';
import { listAllKeys } from '../../utils/r2.js';

/**
 * R2 access helpers for album metadata (info.json) used by the admin API.
 * Every write goes through putInfoJson() so the AlbumInfoDO cache is invalidated.
 */

export function infoKey(albumId) {
  return `albums/${albumId}/info.json`;
}

/**
 * List album IDs by scanning only the first-level "folders" under albums/
 * (R2 delimiter listing), not every object in the bucket.
 */
export async function listAlbumIds(env) {
  const ids = [];
  let cursor;
  do {
    const listed = await env.BUCKET.list({ prefix: "albums/", delimiter: "/", cursor });
    for (const p of listed.delimitedPrefixes || []) {
      const id = p.slice("albums/".length).replace(/\/$/, "");
      if (isValidAlbumId(id)) ids.push(id);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}

export async function getInfoJson(env, albumId) {
  const obj = await env.BUCKET.get(infoKey(albumId));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

export async function albumExists(env, albumId) {
  return !!(await env.BUCKET.head(infoKey(albumId)));
}

export async function putInfoJson(env, albumId, info) {
  await env.BUCKET.put(infoKey(albumId), JSON.stringify(info, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  await invalidateAlbumCache(env, albumId);
}

/** Valid, de-duplicated, sorted photo names from info.files. */
export function getFilesFromInfo(info) {
  const raw = info && Array.isArray(info.files) ? info.files : [];
  const seen = new Set();
  for (const f of raw) {
    const name = String(f || "").trim();
    if (name && isValidPhotoFileName(name)) seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function withFiles(info, files) {
  return { ...(info && typeof info === "object" ? info : {}), files };
}

export function upsertInfoFile(info, name) {
  const files = new Set(getFilesFromInfo(info));
  files.add(name);
  return withFiles(info, [...files].sort((a, b) => a.localeCompare(b)));
}

export function removeInfoFile(info, name) {
  return withFiles(info, getFilesFromInfo(info).filter((n) => n !== name));
}

export function renameInfoFile(info, from, to) {
  const files = new Set(getFilesFromInfo(info).map((n) => (n === from ? to : n)));
  return withFiles(info, [...files].sort((a, b) => a.localeCompare(b)));
}

export function normalizeSecretsToObject(secretsList) {
  const out = {};
  for (const s of secretsList) {
    const secret = String(s || "").trim();
    if (secret) out[secret] = {};
  }
  return out;
}

/** Photo names actually present in R2 under albums/<id>/<kind>/. */
export async function listBucketNames(env, albumId, kind) {
  const prefix = `albums/${albumId}/${kind}/`;
  const keys = await listAllKeys(env.BUCKET, prefix);
  return keys
    .filter((k) => k !== prefix)
    .map((k) => k.substring(prefix.length))
    .filter((n) => isValidPhotoFileName(n))
    .sort((a, b) => a.localeCompare(b));
}
