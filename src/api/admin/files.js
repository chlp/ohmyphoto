import { jsonNoStore, badRequest, conflict, notFound } from '../../utils/response.js';
import { invalidateAlbumCache } from '../../utils/album.js';
import { isValidAlbumId, isValidPhotoFileName, normalizeJpgName } from '../../utils/validate.js';
import { copyObject } from '../../utils/r2.js';
import { readJson } from '../../utils/http.js';
import {
  albumExists,
  getFilesFromInfo,
  getInfoJson,
  listAlbumIds,
  listBucketNames,
  putInfoJson,
  removeInfoFile,
  renameInfoFile,
  upsertInfoFile
} from './infoStore.js';

function photoKey(albumId, name) {
  return `albums/${albumId}/photos/${name}`;
}
function previewKey(albumId, name) {
  return `albums/${albumId}/preview/${name}`;
}

/** JPEG files start with the SOI marker FF D8 FF. */
export async function isJpegBlob(blob) {
  if (!blob || typeof blob.slice !== "function") return false;
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  return head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

async function putJpeg(env, key, file) {
  // Pass the Blob straight through; no need to buffer the whole file into memory.
  await env.BUCKET.put(key, file, { httpMetadata: { contentType: "image/jpeg" } });
}

async function existsAny(env, keys) {
  const heads = await Promise.all(keys.map((k) => env.BUCKET.head(k)));
  return heads.some(Boolean);
}

export async function rebuildAlbumFilesList(env, albumId) {
  const info = await getInfoJson(env, albumId);
  if (!info) return { ok: false, status: 404, error: "Not found" };

  const prev = getFilesFromInfo(info);
  const [names, previews] = await Promise.all([
    listBucketNames(env, albumId, "photos"),
    listBucketNames(env, albumId, "preview")
  ]);
  const previewSet = new Set(previews);
  const missingPreview = names.filter((n) => !previewSet.has(n));

  await putInfoJson(env, albumId, { ...info, files: names });

  const prevSet = new Set(prev);
  const nextSet = new Set(names);
  return {
    ok: true,
    albumId,
    fileCount: names.length,
    added: names.filter((n) => !prevSet.has(n)),
    removed: prev.filter((n) => !nextSet.has(n)),
    missingPreviewCount: missingPreview.length
  };
}

/** POST /api/admin/album/<albumId>/rebuild-files */
export async function handleRebuildFiles({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const r = await rebuildAlbumFilesList(env, albumId);
  if (!r.ok) return notFound();
  return jsonNoStore(r);
}

/** POST /api/admin/albums/rebuild-files */
export async function handleRebuildAllFiles({ env }) {
  const albumIds = await listAlbumIds(env);
  const results = [];
  let totalFiles = 0;
  let totalMissingPreview = 0;
  let albumsOk = 0;
  let albumsErr = 0;

  for (const albumId of albumIds) {
    try {
      const r = await rebuildAlbumFilesList(env, albumId);
      if (r && r.ok) {
        albumsOk += 1;
        totalFiles += Number(r.fileCount) || 0;
        totalMissingPreview += Number(r.missingPreviewCount) || 0;
        results.push(r);
      } else {
        albumsErr += 1;
        results.push({ ok: false, albumId, status: r?.status || 500 });
      }
    } catch {
      albumsErr += 1;
      results.push({ ok: false, albumId, status: 500, error: "rebuild_failed" });
    }
  }

  return jsonNoStore({ ok: true, albumCount: albumIds.length, albumsOk, albumsErr, totalFiles, totalMissingPreview, results });
}

/** GET /api/admin/album/<albumId>/files */
export async function handleListFiles({ env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const info = await getInfoJson(env, albumId);
  if (!info) return notFound();
  const files = getFilesFromInfo(info).map((name) => ({
    name,
    hasPreview: true,
    photoUrl: `/api/admin/album/${encodeURIComponent(albumId)}/raw/photos/${encodeURIComponent(name)}`,
    previewUrl: `/api/admin/album/${encodeURIComponent(albumId)}/raw/preview/${encodeURIComponent(name)}`
  }));
  return jsonNoStore({ albumId, files });
}

/** GET /api/admin/album/<albumId>/raw/(photos|preview)/<name> */
export async function handleRawImage({ env, params: [albumId, kind, name] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  const normalized = normalizeJpgName(name);
  if (!isValidPhotoFileName(normalized)) return badRequest("Invalid file name");

  const obj = await env.BUCKET.get(`albums/${albumId}/${kind}/${normalized}`);
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(obj.body, { headers });
}

/** POST /api/admin/album/<albumId>/file — multipart: photo, preview (JPEG), name?, overwrite? */
export async function handleUploadFile({ request, env, params: [albumId] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  if (!(await albumExists(env, albumId))) return notFound();

  let form;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Expected multipart/form-data");
  }

  const photo = form.get("photo");
  const preview = form.get("preview");
  const overwrite = ["1", "true", "yes"].includes(String(form.get("overwrite") || "").toLowerCase());

  if (!(photo instanceof File)) return badRequest("Missing photo file");
  if (!(preview instanceof File)) return badRequest("Missing preview file");
  if (!(await isJpegBlob(photo))) return badRequest("Photo is not a JPEG");
  if (!(await isJpegBlob(preview))) return badRequest("Preview is not a JPEG");

  const nameRaw = form.get("name") != null ? String(form.get("name") || "") : String(photo.name || "");
  const name = normalizeJpgName(nameRaw);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const keys = [photoKey(albumId, name), previewKey(albumId, name)];
  if (!overwrite && (await existsAny(env, keys))) {
    return conflict("File already exists (set overwrite=1 to replace)");
  }

  await Promise.all([putJpeg(env, keys[0], photo), putJpeg(env, keys[1], preview)]);

  const info = await getInfoJson(env, albumId);
  if (!info) return jsonNoStore({ error: "Missing info.json" }, 500);
  await putInfoJson(env, albumId, upsertInfoFile(info, name));
  return jsonNoStore({ uploaded: true, albumId, name });
}

/** DELETE /api/admin/album/<albumId>/file/<name> */
export async function handleDeleteFile({ env, params: [albumId, nameInPath] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  if (!(await albumExists(env, albumId))) return notFound();
  const name = normalizeJpgName(nameInPath);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const keys = [photoKey(albumId, name), previewKey(albumId, name)];
  if (!(await existsAny(env, keys))) return notFound();
  await env.BUCKET.delete(keys);

  const info = await getInfoJson(env, albumId);
  if (info) await putInfoJson(env, albumId, removeInfoFile(info, name));
  else await invalidateAlbumCache(env, albumId);
  return jsonNoStore({ deleted: true, albumId, name });
}

/** PUT /api/admin/album/<albumId>/file/<name> — body { newName } */
export async function handleRenameFile({ request, env, params: [albumId, nameInPath] }) {
  if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
  if (!(await albumExists(env, albumId))) return notFound();
  const name = normalizeJpgName(nameInPath);
  if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");
  const newName = normalizeJpgName(String(body.newName || body.newFilename || ""));
  if (!isValidPhotoFileName(newName)) return badRequest("Invalid newName");
  if (newName === name) return jsonNoStore({ renamed: true, albumId, from: name, to: newName });

  const from = [photoKey(albumId, name), previewKey(albumId, name)];
  const to = [photoKey(albumId, newName), previewKey(albumId, newName)];

  const [oldPhoto, oldPreview] = await Promise.all(from.map((k) => env.BUCKET.head(k)));
  if (!oldPhoto && !oldPreview) return notFound();
  if (await existsAny(env, to)) return conflict("Destination name already exists");

  await Promise.all([
    oldPhoto ? copyObject(env.BUCKET, from[0], to[0]) : null,
    oldPreview ? copyObject(env.BUCKET, from[1], to[1]) : null
  ]);
  await env.BUCKET.delete(from);

  const info = await getInfoJson(env, albumId);
  if (info) await putInfoJson(env, albumId, renameInfoFile(info, name, newName));
  else await invalidateAlbumCache(env, albumId);
  return jsonNoStore({ renamed: true, albumId, from: name, to: newName });
}
