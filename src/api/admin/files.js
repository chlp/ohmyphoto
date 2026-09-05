import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { isValidAlbumId, isValidPhotoFileName, normalizeJpgName } from '../../utils/validate.js';
import { compareNames, imageObjectKey, isValidPhotoRef, photoObjectKey, previewObjectKey } from '../../utils/albumFiles.js';
import { bytesToHex } from '../../utils/crypto.js';
import { readJson } from '../../utils/http.js';
import {
  PAGE_ATTACH_FILES,
  PAGE_VERIFY_FILES,
  getFileEntries,
  getInfoJson,
  mapLimit,
  removeInfoFile,
  renameInfoFile,
  updateInfoJson,
  upsertInfoFile,
  withFileEntries
} from './infoStore.js';

const JPEG_META = { httpMetadata: { contentType: "image/jpeg" } };

/** JPEG files start with the SOI marker FF D8 FF. */
export async function isJpegBlob(blob) {
  if (!blob || typeof blob.slice !== "function") return false;
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  return head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function isTruthyFlag(v) {
  return v === true || ["1", "true", "yes"].includes(String(v || "").toLowerCase());
}

async function sha256HexOfBuffer(buf) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
}

/** head() both shared objects of a ref; `size` is the original's byte size (undefined if missing). */
async function refObjectsExist(env, ref) {
  const [photo, preview] = await Promise.all([
    env.BUCKET.head(photoObjectKey(ref)),
    env.BUCKET.head(previewObjectKey(ref))
  ]);
  return { photo: !!photo, preview: !!preview, size: photo ? photo.size : undefined };
}

/**
 * Verify one page of an album's `files` against storage.
 *
 * Entries that are not `{ name, ref }` (or duplicates by name) are dropped and counted in
 * `invalid` (this happens on every page but is only non-zero on the first, since the first
 * page's write removes them). Then the first PAGE_VERIFY_FILES entries with name > `after`
 * are checked with one head() pair each: entries whose photo is missing are dropped and listed
 * in `removed`, missing previews are counted, and `size` is (re)recorded. The write is
 * conditional on the ETag (see updateInfoJson). `cursor` is the last checked name, or null
 * when the album is done; `fileCount` is the number of valid entries after this page.
 */
export async function verifyAlbumFiles(env, albumId, { after = null, limit = PAGE_VERIFY_FILES } = {}) {
  const r = await updateInfoJson(env, albumId, async (info) => {
    const rawCount = Array.isArray(info.files) ? info.files.length : 0;
    const all = getFileEntries(info);
    const invalid = rawCount - all.length;

    const start = after ? all.findIndex((e) => compareNames(e.name, after) > 0) : 0;
    const page = start < 0 ? [] : all.slice(start, start + limit);
    const status = await mapLimit(page, 16, (e) => refObjectsExist(env, e.ref));

    const removed = [];
    let missingPreviewCount = 0;
    let sizeUpdated = 0;
    const checked = new Map();
    page.forEach((e, i) => {
      const st = status[i];
      if (!st.photo) {
        removed.push(e.name);
        checked.set(e.name, null);
        return;
      }
      if (!st.preview) missingPreviewCount += 1;
      if (e.size !== st.size) {
        sizeUpdated += 1;
        checked.set(e.name, { ...e, size: st.size });
      }
    });

    const next = all.flatMap((e) => {
      if (!checked.has(e.name)) return [e];
      const v = checked.get(e.name);
      return v ? [v] : [];
    });
    const done = start < 0 || start + limit >= all.length;
    const result = {
      ok: true,
      albumId,
      fileCount: next.length,
      checked: page.length,
      invalid,
      removed,
      missingPreviewCount,
      sizeUpdated,
      cursor: done ? null : page[page.length - 1].name,
      done
    };
    const changed = invalid > 0 || removed.length > 0 || sizeUpdated > 0;
    return changed ? { info: withFileEntries(info, next), result } : { result };
  }, { attempts: 2 });
  return r;
}

/** POST /api/admin/album/<albumId>/verify-files — body { cursor? }; loop until `done`. */
export async function handleVerifyFiles({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const body = (await readJson(request)) || {};
  const after = body.cursor ? String(body.cursor) : null;
  const r = await verifyAlbumFiles(env, albumId, { after });
  if (!r.ok) return r.response;
  return jsonNoStore(r.result);
}

/** GET /api/admin/album/<albumId>/files */
export async function handleListFiles({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const info = await getInfoJson(env, albumId);
  if (!info) return notFound();
  const base = `/api/admin/album/${encodeURIComponent(albumId)}/raw`;
  const files = getFileEntries(info).map(({ name, ref, size }) => ({
    name,
    ref,
    size,
    photoUrl: `${base}/photos/${ref}`,
    previewUrl: `${base}/preview/${ref}`
  }));
  return jsonNoStore({ albumId, files });
}

/** GET /api/admin/album/<albumId>/raw/(photos|preview)/<ref> */
export async function handleRawImage({ env, params: [albumId, kind, ref] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const key = imageObjectKey(kind, ref);
  if (!key) return badRequest("Invalid ref");

  const obj = await env.BUCKET.get(key);
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(obj.body, { headers });
}

/** GET /api/admin/photo/<ref> — does the shared object already exist? (two head() calls) */
export async function handlePhotoExists({ env, params: [ref] }) {
  if (!isValidPhotoRef(ref)) return badRequest("Invalid ref");
  const st = await refObjectsExist(env, ref);
  return jsonNoStore({ ref, exists: st.photo, hasPreview: st.preview });
}

/**
 * POST /api/admin/album/<albumId>/file — multipart: photo, preview (JPEG), name?, ref?, overwrite?
 * `ref` (sha256 hex of the source file) is supplied by the admin UI; without it the ref is the
 * sha256 of the uploaded photo bytes. Shared objects are written only if missing (or overwrite=1).
 * The objects are content-addressed, so they are written first and the info.json entry is
 * added afterwards with a conditional write; a failed write leaves nothing dangling.
 */
export async function handleUploadFile({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

  let form;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Expected multipart/form-data");
  }

  const photo = form.get("photo");
  const preview = form.get("preview");
  const overwrite = isTruthyFlag(form.get("overwrite"));

  if (!(photo instanceof File)) return badRequest("Missing photo file");
  if (!(preview instanceof File)) return badRequest("Missing preview file");
  if (!(await isJpegBlob(photo))) return badRequest("Photo is not a JPEG");
  if (!(await isJpegBlob(preview))) return badRequest("Preview is not a JPEG");

  const nameRaw = form.get("name") != null ? String(form.get("name") || "") : String(photo.name || "");
  const name = normalizeJpgName(nameRaw);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const refIn = String(form.get("ref") || "").trim().toLowerCase();
  if (refIn && !isValidPhotoRef(refIn)) return badRequest("Invalid ref");

  const info = await getInfoJson(env, albumId);
  if (!info) return notFound();

  let ref = refIn;
  let photoBody = photo;
  const size = photo.size;
  if (!ref) {
    const buf = await photo.arrayBuffer();
    ref = await sha256HexOfBuffer(buf);
    photoBody = buf;
  }

  // Early check on the snapshot so a plain name clash fails before any object write; the
  // authoritative check runs again inside the conditional update below.
  const existing = getFileEntries(info).find((e) => e.name === name);
  if (existing && existing.ref !== ref && !overwrite) {
    return conflict("File already exists (set overwrite=1 to replace)");
  }

  const st = await refObjectsExist(env, ref);
  const writes = [];
  if (!st.photo || overwrite) writes.push(env.BUCKET.put(photoObjectKey(ref), photoBody, JPEG_META));
  if (!st.preview || overwrite) writes.push(env.BUCKET.put(previewObjectKey(ref), preview, JPEG_META));
  await Promise.all(writes);

  // With overwrite the uploaded bytes are what is stored; otherwise the existing object wins.
  const storedSize = st.photo && !overwrite ? st.size : size;
  const r = await updateInfoJson(env, albumId, (cur) => {
    const clash = getFileEntries(cur).find((e) => e.name === name);
    if (clash && clash.ref !== ref && !overwrite) {
      return { response: conflict("File already exists (set overwrite=1 to replace)") };
    }
    return { info: upsertInfoFile(cur, { name, ref, size: storedSize }) };
  });
  if (!r.ok) return r.response;
  return jsonNoStore({ uploaded: true, albumId, name, ref, size: storedSize, stored: writes.length > 0 });
}

/**
 * POST /api/admin/album/<albumId>/files — body { files: [{ name, ref }], overwrite? }
 * Attach already-stored photos (from another album or a de-duplicated upload) to this album.
 * At most PAGE_ATTACH_FILES per request (one head() each); the admin UI sends chunks.
 */
export async function handleAttachFiles({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

  const body = await readJson(request);
  if (!body || !Array.isArray(body.files)) return badRequest("Expected { files: [{ name, ref }] }");
  if (body.files.length > PAGE_ATTACH_FILES) return badRequest(`Too many files (max ${PAGE_ATTACH_FILES} per request)`);
  const overwrite = isTruthyFlag(body.overwrite);

  const wanted = [];
  const seen = new Set();
  for (const f of body.files) {
    const name = normalizeJpgName(f && f.name);
    const ref = String((f && f.ref) || "").trim().toLowerCase();
    if (!isValidPhotoFileName(name)) return badRequest(`Invalid file name: ${String((f && f.name) || "")}`);
    if (!isValidPhotoRef(ref)) return badRequest(`Invalid ref for ${name}`);
    if (seen.has(name)) return badRequest(`Duplicate name: ${name}`);
    seen.add(name);
    wanted.push({ name, ref });
  }

  const status = await mapLimit(wanted, 16, (e) => env.BUCKET.head(photoObjectKey(e.ref)));
  const missing = wanted.filter((_, i) => !status[i]).map((e) => e.ref);
  if (missing.length) return jsonNoStore({ error: "Unknown photo refs", missing }, 400);
  wanted.forEach((e, i) => { e.size = status[i].size; });

  const r = await updateInfoJson(env, albumId, (info) => {
    const current = getFileEntries(info);
    if (!overwrite) {
      const taken = wanted.filter((w) => current.some((c) => c.name === w.name && c.ref !== w.ref)).map((w) => w.name);
      if (taken.length) {
        return { response: jsonNoStore({ error: "File names already exist (set overwrite to replace)", conflicts: taken }, 409) };
      }
    }
    const wantedNames = new Set(wanted.map((w) => w.name));
    const next = [...current.filter((c) => !wantedNames.has(c.name)), ...wanted];
    return { info: withFileEntries(info, next) };
  });
  if (!r.ok) return r.response;
  return jsonNoStore({ attached: wanted.length, albumId, files: wanted });
}

/** DELETE /api/admin/album/<albumId>/file/<name> — removes the entry; the shared object stays (see GC). */
export async function handleDeleteFile({ env, params: [albumId, nameInPath] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const name = normalizeJpgName(nameInPath);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const r = await updateInfoJson(env, albumId, (info) => {
    const entry = getFileEntries(info).find((e) => e.name === name);
    if (!entry) return { response: notFound() };
    return { info: removeInfoFile(info, name), result: { ref: entry.ref } };
  });
  if (!r.ok) return r.response;
  return jsonNoStore({ deleted: true, albumId, name, ref: r.result.ref });
}

/** PUT /api/admin/album/<albumId>/file/<name> — body { newName }. Metadata-only. */
export async function handleRenameFile({ request, env, params: [albumId, nameInPath] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const name = normalizeJpgName(nameInPath);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");
  const newName = normalizeJpgName(String(body.newName || body.newFilename || ""));
  if (!isValidPhotoFileName(newName)) return badRequest("Invalid newName");
  if (newName === name) return jsonNoStore({ renamed: true, albumId, from: name, to: newName });

  const r = await updateInfoJson(env, albumId, (info) => {
    const entries = getFileEntries(info);
    if (!entries.some((e) => e.name === name)) return { response: notFound() };
    if (entries.some((e) => e.name === newName)) return { response: conflict("Destination name already exists") };
    return { info: renameInfoFile(info, name, newName) };
  });
  if (!r.ok) return r.response;
  return jsonNoStore({ renamed: true, albumId, from: name, to: newName });
}
