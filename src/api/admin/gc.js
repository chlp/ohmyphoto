import { jsonNoStore, badRequest } from '../../utils/response.js';
import { parseFileEntries } from '../../utils/albumFiles.js';
import { randomHex } from '../../utils/crypto.js';
import { readJson } from '../../utils/http.js';
import { getInfoJson, listAlbumIds, mapLimit } from './infoStore.js';

/**
 * Garbage collection for the shared photo storage. Album and photo operations never delete
 * photos/<ref>.jpg objects (they may be referenced by other albums); this explicit, batched
 * admin action reclaims unreferenced ones. Together with the album list and trash this is the
 * only place that lists R2; public paths never do.
 *
 * A run is a sequence of POST photos/gc calls chained by `cursor`, each within the Free-plan
 * subrequest budget (see infoStore.js):
 *
 *   phase "refs"  walks the albums one page at a time and accumulates every referenced ref in
 *                 a snapshot object gc/<runId>.json   (1 list + <=25 reads + 1 get + 1 put)
 *   phase "scan"  walks photos/ then previews/ one list page (1000 keys) at a time, compares
 *                 against the snapshot and deletes orphans in chunks of 100
 *                 (1 get + 1 list + <=10 deletes); the snapshot is deleted when the run ends.
 *
 * Cursor format: "<phase>|<runId>|<state>"; a missing cursor starts a new run. Objects
 * uploaded less than PHOTO_GC_GRACE_MS ago are skipped so an upload whose info.json write has
 * not landed yet is never collected. An abandoned run leaves a small gc/<runId>.json behind.
 */

const DEFAULT_GC_GRACE_MS = 60 * 60 * 1000;
const GC_LIST_LIMIT = 1000;
const PREFIXES = ["photos/", "previews/"];

function snapshotKey(runId) {
  return `gc/${runId}.json`;
}

function refFromKey(prefix, key) {
  if (!key.startsWith(prefix) || !key.endsWith(".jpg")) return null;
  const ref = key.slice(prefix.length, -4);
  return /^[a-f0-9]{64}$/.test(ref) ? ref : null;
}

function parseCursor(raw) {
  if (!raw) return { phase: "refs", runId: randomHex(8), state: "" };
  const [phase, runId, ...rest] = String(raw).split("|");
  if (!["refs", "scan"].includes(phase) || !/^[a-f0-9]{16}$/.test(runId || "")) return null;
  return { phase, runId, state: rest.join("|") };
}

async function readSnapshot(env, runId) {
  const obj = await env.BUCKET.get(snapshotKey(runId));
  if (!obj) return null;
  try {
    const v = await obj.json();
    return { refs: Array.isArray(v.refs) ? v.refs : [], albumCount: Number(v.albumCount) || 0 };
  } catch {
    return null;
  }
}

/** One page of albums -> refs appended to the snapshot. */
async function stepRefs(env, runId, albumCursor) {
  const snap = albumCursor ? await readSnapshot(env, runId) : { refs: [], albumCount: 0 };
  if (!snap) return null;
  const { ids, cursor } = await listAlbumIds(env, { cursor: albumCursor || undefined });
  const refs = new Set(snap.refs);
  await mapLimit(ids, 16, async (albumId) => {
    const info = await getInfoJson(env, albumId);
    if (!info) return;
    for (const e of parseFileEntries(info)) refs.add(e.ref);
  });
  const next = { refs: [...refs], albumCount: snap.albumCount + ids.length };
  await env.BUCKET.put(snapshotKey(runId), JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
  return { snapshot: next, cursor: cursor ? `refs|${runId}|${cursor}` : `scan|${runId}|${PREFIXES[0]}|` };
}

/** One list page of a photo prefix compared against the snapshot. */
async function stepScan(env, runId, state, { dryRun, graceMs }) {
  const [prefix, listCursor] = state.split("|");
  const prefixIdx = PREFIXES.indexOf(prefix);
  if (prefixIdx < 0) return null;
  const snap = await readSnapshot(env, runId);
  if (!snap) return null;
  const refs = new Set(snap.refs);

  const listed = await env.BUCKET.list({ prefix, cursor: listCursor || undefined, limit: GC_LIST_LIMIT });
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

  let cursor = null;
  if (listed.truncated) cursor = `scan|${runId}|${prefix}|${listed.cursor}`;
  else if (prefixIdx + 1 < PREFIXES.length) cursor = `scan|${runId}|${PREFIXES[prefixIdx + 1]}|`;
  else await env.BUCKET.delete(snapshotKey(runId));

  return {
    snapshot: snap,
    cursor,
    prefix,
    scanned: listed.objects.length,
    skippedRecent,
    orphanCount: orphans.length,
    orphans: orphans.slice(0, 200),
    deleted
  };
}

/** POST /api/admin/photos/gc — body { dryRun?: boolean (default true), cursor?: string } */
export async function handleGcPhotos({ request, env }) {
  const body = (await readJson(request)) || {};
  const dryRun = body.dryRun !== false && String(body.dryRun || "") !== "0";
  const graceMs = env.PHOTO_GC_GRACE_MS != null ? Number(env.PHOTO_GC_GRACE_MS) : DEFAULT_GC_GRACE_MS;

  const c = parseCursor(body.cursor);
  if (!c) return badRequest("Invalid cursor");

  const step = c.phase === "refs"
    ? await stepRefs(env, c.runId, c.state)
    : await stepScan(env, c.runId, c.state, { dryRun, graceMs });
  if (!step) return badRequest("Unknown or expired GC run, start again without a cursor");

  return jsonNoStore({
    ok: true,
    dryRun,
    phase: c.phase,
    runId: c.runId,
    done: step.cursor === null,
    cursor: step.cursor,
    prefix: step.prefix || null,
    albumCount: step.snapshot.albumCount,
    referencedRefs: step.snapshot.refs.length,
    scanned: step.scanned || 0,
    skippedRecent: step.skippedRecent || 0,
    orphanCount: step.orphanCount || 0,
    orphans: step.orphans || [],
    deleted: step.deleted || 0
  });
}
