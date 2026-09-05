import { invalidateAlbumCache } from '../../utils/album.js';
import { isValidAlbumId } from '../../utils/validate.js';
import { normalizeFileEntry, parseFileEntries, sortFileEntries } from '../../utils/albumFiles.js';

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

/** Valid, de-duplicated file entries from info.files, sorted by name. */
export function getFileEntries(info) {
  return sortFileEntries(parseFileEntries(info));
}

/** Return `info` with `files` replaced by `entries` (sorted by name, `{ name, ref, size? }` only). */
export function withFileEntries(info, entries) {
  return {
    ...(info && typeof info === "object" ? info : {}),
    files: sortFileEntries(entries.map(normalizeFileEntry).filter(Boolean))
  };
}

/** Add or replace (by name) one entry `{ name, ref, size? }`. */
export function upsertInfoFile(info, entry) {
  const entries = getFileEntries(info).filter((e) => e.name !== entry.name);
  entries.push(entry);
  return withFileEntries(info, entries);
}

export function removeInfoFile(info, name) {
  return withFileEntries(info, getFileEntries(info).filter((e) => e.name !== name));
}

export function renameInfoFile(info, from, to) {
  const entries = getFileEntries(info)
    .filter((e) => e.name !== to)
    .map((e) => (e.name === from ? { ...e, name: to } : e));
  return withFileEntries(info, entries);
}

export function normalizeSecretsToObject(secretsList) {
  const out = {};
  for (const s of secretsList) {
    const secret = String(s || "").trim();
    if (secret) out[secret] = {};
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
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
