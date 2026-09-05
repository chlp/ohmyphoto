import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { isValidAlbumId, isValidPhotoFileName, normalizeJpgName } from '../../utils/validate.js';
import { imageObjectKey, isValidPhotoRef, photoObjectKey, previewObjectKey } from '../../utils/albumFiles.js';
import { bytesToHex } from '../../utils/crypto.js';
import { readJson } from '../../utils/http.js';
import {
  albumExists,
  getFileEntries,
  getInfoJson,
  listAlbumIds,
  mapLimit,
  putInfoJson,
  removeInfoFile,
  renameInfoFile,
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
 * Verify `files` of one album against storage: entries that are not `{ name, ref }` (or are
 * duplicates by name) are dropped and counted in `invalid`, entries whose photos/<ref>.jpg is
 * missing are dropped and listed in `removed`, missing previews are counted, and each kept
 * entry's `size` is (re)recorded from the object. One head() pair per entry, no listing.
 */
export async function verifyAlbumFiles(env, albumId) {
  const info = await getInfoJson(env, albumId);
  if (!info) return { ok: false, status: 404 };

  const rawCount = Array.isArray(info.files) ? info.files.length : 0;
  const prev = getFileEntries(info);
  const invalid = rawCount - prev.length;
  const status = await mapLimit(prev, 16, (e) => refObjectsExist(env, e.ref));
  const kept = prev.filter((_, i) => status[i].photo);
  const removed = prev.filter((_, i) => !status[i].photo).map((e) => e.name);
  const missingPreviewCount = status.filter((s) => s.photo && !s.preview).length;

  let sizeUpdated = 0;
  const next = prev.flatMap((e, i) => {
    if (!status[i].photo) return [];
    if (e.size === status[i].size) return [e];
    sizeUpdated += 1;
    return [{ ...e, size: status[i].size }];
  });

  if (invalid || removed.length || sizeUpdated) await putInfoJson(env, albumId, withFileEntries(info, next));
  return { ok: true, albumId, fileCount: kept.length, invalid, removed, missingPreviewCount, sizeUpdated };
}

/** POST /api/admin/album/<albumId>/verify-files */
export async function handleVerifyFiles({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const r = await verifyAlbumFiles(env, albumId);
  if (!r.ok) return notFound();
  return jsonNoStore(r);
}

/** POST /api/admin/albums/verify-files */
export async function handleVerifyAllFiles({ env }) {
  const albumIds = await listAlbumIds(env);
  const results = [];
  let totalFiles = 0;
  let totalInvalid = 0;
  let totalRemoved = 0;
  let totalMissingPreview = 0;
  let albumsErr = 0;
  for (const albumId of albumIds) {
    try {
      const r = await verifyAlbumFiles(env, albumId);
      if (!r.ok) throw new Error("verify_failed");
      totalFiles += r.fileCount;
      totalInvalid += r.invalid;
      totalRemoved += r.removed.length;
      totalMissingPreview += r.missingPreviewCount;
      results.push(r);
    } catch {
      albumsErr += 1;
      results.push({ ok: false, albumId });
    }
  }
  return jsonNoStore({ ok: true, albumCount: albumIds.length, albumsErr, totalFiles, totalInvalid, totalRemoved, totalMissingPreview, results });
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
  const existing = getFileEntries(info).find((e) => e.name === name);

  let ref = refIn;
  let photoBody = photo;
  const size = photo.size;
  if (!ref) {
    const buf = await photo.arrayBuffer();
    ref = await sha256HexOfBuffer(buf);
    photoBody = buf;
  }

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
  await putInfoJson(env, albumId, upsertInfoFile(info, { name, ref, size: storedSize }));
  return jsonNoStore({ uploaded: true, albumId, name, ref, size: storedSize, stored: writes.length > 0 });
}

/**
 * POST /api/admin/album/<albumId>/files — body { files: [{ name, ref }], overwrite? }
 * Attach already-stored photos (from another album or a de-duplicated upload) to this album.
 */
export async function handleAttachFiles({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

  const body = await readJson(request);
  if (!body || !Array.isArray(body.files)) return badRequest("Expected { files: [{ name, ref }] }");
  if (body.files.length > 1000) return badRequest("Too many files (max 1000 per request)");
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

  const info = await getInfoJson(env, albumId);
  if (!info) return notFound();

  const status = await mapLimit(wanted, 16, (e) => env.BUCKET.head(photoObjectKey(e.ref)));
  const missing = wanted.filter((_, i) => !status[i]).map((e) => e.ref);
  if (missing.length) return jsonNoStore({ error: "Unknown photo refs", missing }, 400);
  wanted.forEach((e, i) => { e.size = status[i].size; });

  const current = getFileEntries(info);
  if (!overwrite) {
    const taken = wanted.filter((w) => current.some((c) => c.name === w.name && c.ref !== w.ref)).map((w) => w.name);
    if (taken.length) return jsonNoStore({ error: "File names already exist (set overwrite to replace)", conflicts: taken }, 409);
  }

  const wantedNames = new Set(wanted.map((w) => w.name));
  const next = [...current.filter((c) => !wantedNames.has(c.name)), ...wanted];
  await putInfoJson(env, albumId, withFileEntries(info, next));
  return jsonNoStore({ attached: wanted.length, albumId, files: wanted });
}

/** DELETE /api/admin/album/<albumId>/file/<name> — removes the entry; the shared object stays (see GC). */
export async function handleDeleteFile({ env, params: [albumId, nameInPath] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const name = normalizeJpgName(nameInPath);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const info = await getInfoJson(env, albumId);
  if (!info) return notFound();
  const entry = getFileEntries(info).find((e) => e.name === name);
  if (!entry) return notFound();

  await putInfoJson(env, albumId, removeInfoFile(info, name));
  return jsonNoStore({ deleted: true, albumId, name, ref: entry.ref });
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

  const info = await getInfoJson(env, albumId);
  if (!info) return notFound();
  const entries = getFileEntries(info);
  if (!entries.some((e) => e.name === name)) return notFound();
  if (entries.some((e) => e.name === newName)) return conflict("Destination name already exists");

  await putInfoJson(env, albumId, renameInfoFile(info, name, newName));
  return jsonNoStore({ renamed: true, albumId, from: name, to: newName });
}
