import { invalidateAlbumCache } from '../../utils/album.js';
import { conflict, notFound } from '../../utils/response.js';
import { isValidAlbumId } from '../../utils/validate.js';
import { compareNames, normalizeFileEntry, parseFileEntries, sortFileEntries } from '../../utils/albumFiles.js';

/**
 * R2 access helpers for album metadata (info.json) used by the admin API.
 *
 * Writes: every info.json write goes through putInfoJson() so the AlbumInfoDO cache is
 * invalidated. Read-modify-write cycles use updateInfoJson(), which writes conditionally on the
 * ETag read at the start and retries on a concurrent change (two admin tabs, upload racing a
 * rename), so no update is silently lost.
 *
 * Subrequest budget: every R2 or Durable Object call counts as one subrequest and a Worker on
 * the Free plan gets 50 per request. Admin operations that touch many objects are therefore
 * paginated by cursor and sized well below that budget (see the PAGE_* constants); the admin UI
 * loops until `done`.
 */

/** Albums per page in the album list (1 list call + 1 DO/R2 read per album). */
export const PAGE_ALBUMS = 25;
/** File entries per verify-files page (2 head() calls per entry + 1 get + 1 put). */
export const PAGE_VERIFY_FILES = 20;
/** Max entries per attach request (1 head() per entry + 1 get + 1 put). */
export const PAGE_ATTACH_FILES = 20;

export function infoKey(albumId) {
  return `albums/${albumId}/info.json`;
}

/**
 * One page of album IDs from the first-level "folders" under albums/ (R2 delimiter listing,
 * never scans photo objects). `cursor` is opaque; `null` in the result means the listing is
 * complete. Pages come back in R2 key order.
 * @returns {Promise<{ ids: string[], cursor: string|null }>}
 */
export async function listAlbumIds(env, { cursor, limit = PAGE_ALBUMS } = {}) {
  const listed = await env.BUCKET.list({ prefix: "albums/", delimiter: "/", cursor: cursor || undefined, limit });
  const ids = [];
  for (const p of listed.delimitedPrefixes || []) {
    const id = p.slice("albums/".length).replace(/\/$/, "");
    if (isValidAlbumId(id)) ids.push(id);
  }
  ids.sort(compareNames);
  return { ids, cursor: listed.truncated ? listed.cursor : null };
}

/** Parsed info.json plus the object's ETag (for conditional writes); null if missing/unparsable. */
export async function getInfoJsonWithEtag(env, albumId) {
  const obj = await env.BUCKET.get(infoKey(albumId));
  if (!obj) return null;
  try {
    return { info: await obj.json(), etag: obj.etag };
  } catch {
    return null;
  }
}

export async function getInfoJson(env, albumId) {
  const r = await getInfoJsonWithEtag(env, albumId);
  return r ? r.info : null;
}

export async function albumExists(env, albumId) {
  return !!(await env.BUCKET.head(infoKey(albumId)));
}

/**
 * Write info.json and invalidate the DO cache. With `etag` the write only happens if the
 * object still has that ETag; returns false (and invalidates nothing) when it does not.
 * @returns {Promise<boolean>}
 */
export async function putInfoJson(env, albumId, info, { etag } = {}) {
  const opts = { httpMetadata: { contentType: "application/json; charset=utf-8" } };
  if (etag) opts.onlyIf = { etagMatches: etag };
  const put = await env.BUCKET.put(infoKey(albumId), JSON.stringify(info, null, 2), opts);
  if (etag && !put) return false;
  await invalidateAlbumCache(env, albumId);
  return true;
}

/**
 * Optimistic read-modify-write of info.json.
 *
 * `fn(info)` (may be async) returns one of:
 *   { response }        abort with this Response (validation error etc.), nothing written
 *   { info, result? }   write `info` conditionally on the ETag read before calling fn
 *   { result? }         nothing to write
 * On an ETag mismatch the whole cycle is retried with fresh data, up to `attempts` times.
 * @returns {Promise<{ ok: true, result: any } | { ok: false, response: Response }>}
 */
export async function updateInfoJson(env, albumId, fn, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const cur = await getInfoJsonWithEtag(env, albumId);
    if (!cur) return { ok: false, response: notFound() };
    const r = (await fn(cur.info)) || {};
    if (r.response) return { ok: false, response: r.response };
    if (!r.info) return { ok: true, result: r.result };
    if (await putInfoJson(env, albumId, r.info, { etag: cur.etag })) return { ok: true, result: r.result };
  }
  return { ok: false, response: conflict("Album was modified concurrently, please retry") };
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
