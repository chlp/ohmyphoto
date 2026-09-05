import { jsonNoStore } from '../../utils/response.js';
import { parseFileEntries } from '../../utils/albumFiles.js';
import { readJson } from '../../utils/http.js';
import { getInfoJson, listAlbumIds, mapLimit } from './infoStore.js';

/**
 * Garbage collection for the shared photo storage. Album and photo operations never delete
 * photos/<ref>.jpg objects (they may be referenced by other albums); this explicit, batched
 * admin action reclaims unreferenced ones. Together with the album list this is the only
 * place that lists R2; public paths never do.
 */

const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000;
const GC_LIST_LIMIT = 1000;
const PREFIXES = ["photos/", "previews/"];

/** Set of refs referenced by any album (reads every info.json). */
export async function collectReferencedRefs(env) {
  const albumIds = await listAlbumIds(env);
  const refs = new Set();
  await mapLimit(albumIds, 16, async (albumId) => {
    const info = await getInfoJson(env, albumId);
    if (!info) return;
    for (const e of parseFileEntries(info)) refs.add(e.ref);
  });
  return { refs, albumCount: albumIds.length };
}

function refFromKey(prefix, key) {
  if (!key.startsWith(prefix) || !key.endsWith(".jpg")) return null;
  const ref = key.slice(prefix.length, -4);
  return /^[a-f0-9]{64}$/.test(ref) ? ref : null;
}

/**
 * POST /api/admin/photos/gc — body { dryRun?: boolean (default true), cursor?: string }
 * Scans photos/ then previews/, one list page per call, and deletes objects that no album
 * references. Objects uploaded less than PHOTO_GC_GRACE_MS ago are skipped so an upload
 * whose info.json write has not landed yet is never collected. Repeat with `cursor` until `done`.
 */
export async function handleGcPhotos({ request, env }) {
  const body = (await readJson(request)) || {};
  const dryRun = body.dryRun !== false && String(body.dryRun || "") !== "0";
  const graceMs = env.PHOTO_GC_GRACE_MS != null ? Number(env.PHOTO_GC_GRACE_MS) : DEFAULT_GC_GRACE_MS;

  let prefixIdx = 0;
  let cursor;
  if (body.cursor) {
    const [p, c] = String(body.cursor).split("|");
    prefixIdx = Math.max(0, PREFIXES.indexOf(p));
    cursor = c || undefined;
  }

  const { refs, albumCount } = await collectReferencedRefs(env);
  const prefix = PREFIXES[prefixIdx];
  const listed = await env.BUCKET.list({ prefix, cursor, limit: GC_LIST_LIMIT });

  const now = Date.now();
  const orphans = [];
  let skippedRecent = 0;
  for (const o of listed.objects) {
    const ref = refFromKey(prefix, o.key);
    if (ref && refs.has(ref)) continue;
    const uploadedMs = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(new Date(o.uploaded)) || 0;
    if (graceMs > 0 && now - uploadedMs < graceMs) {
      skippedRecent += 1;
      continue;
    }
    orphans.push(o.key);
  }

  let deleted = 0;
  if (!dryRun) {
    for (let i = 0; i < orphans.length; i += 100) {
      const chunk = orphans.slice(i, i + 100);
      await env.BUCKET.delete(chunk);
      deleted += chunk.length;
    }
  }

  let nextCursor = null;
  if (listed.truncated) nextCursor = `${prefix}|${listed.cursor}`;
  else if (prefixIdx + 1 < PREFIXES.length) nextCursor = `${PREFIXES[prefixIdx + 1]}|`;

  return jsonNoStore({
    ok: true,
    dryRun,
    done: nextCursor === null,
    cursor: nextCursor,
    prefix,
    albumCount,
    referencedRefs: refs.size,
    scanned: listed.objects.length,
    skippedRecent,
    orphanCount: orphans.length,
    orphans: orphans.slice(0, 200),
    deleted
  });
}
