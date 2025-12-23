import { json } from '../utils/response.js';
import { getAlbumInfoWithSecrets, invalidateAlbumCache } from '../utils/album.js';
import { invalidateAlbumIndex } from '../utils/albumIndex.js';
import { timingSafeEqual } from '../utils/crypto.js';
import { issueAdminSessionToken, verifyAdminSessionToken } from '../utils/session.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { isValidAlbumId, isValidPhotoFileName, normalizeJpgName } from '../utils/validate.js';
import { copyObject, listAllKeys } from '../utils/r2.js';
import { readJson } from '../utils/http.js';

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": "Bearer realm=\"admin\""
    }
  });
}

async function authorizeAdmin(request, env) {
  const expected = String(env.ADMIN_TOKEN || "");
  if (!expected) return unauthorized();
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : "";
  if (!token) return unauthorized();

  // Otherwise treat as a signed session token
  const v = await verifyAdminSessionToken(token, expected);
  if (!v.ok) return unauthorized();
  return null;
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

function conflict(msg) {
  return json({ error: msg }, 409);
}

function ok(obj = {}) {
  return json(obj, 200, { "Cache-Control": "no-store" });
}

function randomHex(bytesLen) {
  const bytes = new Uint8Array(bytesLen);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function generateAlbumSecret32() {
  // 16 bytes => 32 hex chars
  return randomHex(16);
}

async function listAlbumInfoKeys(env) {
  const keys = [];
  let cursor = undefined;
  do {
    const listed = await env.BUCKET.list({ prefix: "albums/", cursor });
    for (const o of listed.objects) {
      if (o.key.endsWith("/info.json")) keys.push(o.key);
    }
    cursor = listed.cursor;
  } while (cursor);
  return keys;
}

async function getInfoJson(env, albumId) {
  const key = `albums/${albumId}/info.json`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

function normalizeSecretsToObject(secretsList) {
  const out = {};
  for (const s of secretsList) {
    const secret = String(s || "").trim();
    if (secret) out[secret] = {};
  }
  return out;
}

async function getAlbumExists(env, albumId) {
  const existing = await env.BUCKET.get(`albums/${albumId}/info.json`);
  return !!existing;
}

async function listAlbumPhotoNames(env, albumId) {
  const photosPrefix = `albums/${albumId}/photos/`;
  const previewPrefix = `albums/${albumId}/preview/`;
  const [photoKeys, previewKeys] = await Promise.all([
    listAllKeys(env.BUCKET, photosPrefix),
    listAllKeys(env.BUCKET, previewPrefix)
  ]);

  const photoNames = photoKeys
    .filter((k) => k !== photosPrefix)
    .map((k) => k.substring(photosPrefix.length))
    .sort((a, b) => a.localeCompare(b));

  const previewSet = new Set(
    previewKeys
      .filter((k) => k !== previewPrefix)
      .map((k) => k.substring(previewPrefix.length))
  );

  return photoNames.map((name) => ({
    name,
    hasPreview: previewSet.has(name),
    photoUrl: `/api/admin/album/${encodeURIComponent(albumId)}/raw/photos/${encodeURIComponent(name)}`,
    previewUrl: `/api/admin/album/${encodeURIComponent(albumId)}/raw/preview/${encodeURIComponent(name)}`
  }));
}

async function putJpeg(env, key, file) {
  const buf = await file.arrayBuffer();
  await env.BUCKET.put(key, buf, {
    httpMetadata: {
      contentType: "image/jpeg"
    }
  });
}

async function renameAlbum(env, oldAlbumId, newAlbumId) {
  const oldPrefix = `albums/${oldAlbumId}/`;
  const newPrefix = `albums/${newAlbumId}/`;

  // Ensure destination does not exist
  const exists = await env.BUCKET.get(`${newPrefix}info.json`);
  if (exists) {
    throw new Error("destination_exists");
  }

  const keys = await listAllKeys(env.BUCKET, oldPrefix);
  if (!keys.length) {
    throw new Error("source_missing");
  }

  for (const key of keys) {
    const newKey = newPrefix + key.substring(oldPrefix.length);
    await copyObject(env.BUCKET, key, newKey);
  }

  // Delete old after copy
  for (let i = 0; i < keys.length; i += 100) {
    await env.BUCKET.delete(keys.slice(i, i + 100));
  }
}

async function deleteAlbum(env, albumId) {
  const prefix = `albums/${albumId}/`;
  const keys = await listAllKeys(env.BUCKET, prefix);
  if (!keys.length) return false;
  for (let i = 0; i < keys.length; i += 100) {
    await env.BUCKET.delete(keys.slice(i, i + 100));
  }
  return true;
}

/**
 * Handle /api/admin/*
 */
export async function handleAdminRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // POST /api/admin/session (exchange ADMIN_TOKEN -> 24h session token)
  if (path === "/api/admin/session" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return badRequest("Bad JSON");
    const provided = String(body.token || body.adminToken || "");
    const turnstileToken = String(body.turnstileToken || "");
    const expected = String(env.ADMIN_TOKEN || "");
    if (!expected) return unauthorized();

    // Verify Turnstile token if secret key is configured
    if (env.TURNSTILE_SECRET_KEY) {
      if (!turnstileToken) {
        return new Response("Bot verification required", { status: 403 });
      }
      const clientIP = request.headers.get('CF-Connecting-IP') || null;
      const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
      const turnstileResult = await verifyTurnstileToken(
        turnstileToken,
        env.TURNSTILE_SECRET_KEY,
        clientIP,
        turnstileTimeoutMs
      );
      if (!turnstileResult.success) {
        return new Response("Bot verification failed", { status: 403 });
      }
    }

    if (!provided || !timingSafeEqual(provided, expected)) return unauthorized();

    const issued = await issueAdminSessionToken(expected);
    return ok({ sessionToken: issued.token, iat: issued.payload.iat, exp: issued.payload.exp });
  }

  const authErr = await authorizeAdmin(request, env);
  if (authErr) return authErr;

  // GET /api/admin/album/<albumId>/files
  const mFiles = path.match(/^\/api\/admin\/album\/([^/]+)\/files$/);
  if (mFiles && request.method === "GET") {
    const albumId = decodeURIComponent(mFiles[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const exists = await getAlbumExists(env, albumId);
    if (!exists) return new Response("Not found", { status: 404 });
    const files = await listAlbumPhotoNames(env, albumId);
    return ok({ albumId, files });
  }

  // GET /api/admin/album/<albumId>/raw/(photos|preview)/<name>
  const mRaw = path.match(/^\/api\/admin\/album\/([^/]+)\/raw\/(photos|preview)\/(.+)$/);
  if (mRaw && request.method === "GET") {
    const albumId = decodeURIComponent(mRaw[1]);
    const kind = mRaw[2];
    const name = decodeURIComponent(mRaw[3]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const normalized = normalizeJpgName(name);
    if (!isValidPhotoFileName(normalized)) return badRequest("Invalid file name");

    const key = `albums/${albumId}/${kind}/${normalized}`;
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("ETag", obj.httpEtag);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(obj.body, { headers });
  }

  // POST /api/admin/album/<albumId>/file (upload one photo+preview, both JPEG)
  const mUpload = path.match(/^\/api\/admin\/album\/([^/]+)\/file$/);
  if (mUpload && request.method === "POST") {
    const albumId = decodeURIComponent(mUpload[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const exists = await getAlbumExists(env, albumId);
    if (!exists) return new Response("Not found", { status: 404 });

    let form;
    try {
      form = await request.formData();
    } catch {
      return badRequest("Expected multipart/form-data");
    }

    const photo = form.get("photo");
    const preview = form.get("preview");
    const overwriteRaw = String(form.get("overwrite") || "").toLowerCase();
    const overwrite = overwriteRaw === "1" || overwriteRaw === "true" || overwriteRaw === "yes";

    if (!(photo instanceof File)) return badRequest("Missing photo file");
    if (!(preview instanceof File)) return badRequest("Missing preview file");

    const nameRaw = form.get("name") != null ? String(form.get("name") || "") : String(photo.name || "");
    const name = normalizeJpgName(nameRaw);
    if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

    const photoKey = `albums/${albumId}/photos/${name}`;
    const previewKey = `albums/${albumId}/preview/${name}`;

    if (!overwrite) {
      const [p0, p1] = await Promise.all([env.BUCKET.get(photoKey), env.BUCKET.get(previewKey)]);
      if (p0 || p1) return conflict("File already exists (set overwrite=1 to replace)");
    }

    await Promise.all([
      putJpeg(env, photoKey, photo),
      putJpeg(env, previewKey, preview)
    ]);

    await invalidateAlbumIndex(env, albumId);
    return ok({ uploaded: true, albumId, name });
  }

  // PUT/DELETE /api/admin/album/<albumId>/file/<name>
  const mFile = path.match(/^\/api\/admin\/album\/([^/]+)\/file\/(.+)$/);
  if (mFile && (request.method === "DELETE" || request.method === "PUT")) {
    const albumId = decodeURIComponent(mFile[1]);
    const nameInPath = decodeURIComponent(mFile[2]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const exists = await getAlbumExists(env, albumId);
    if (!exists) return new Response("Not found", { status: 404 });

    const name = normalizeJpgName(nameInPath);
    if (!isValidPhotoFileName(name)) return badRequest("Invalid file name");

    const photoKey = `albums/${albumId}/photos/${name}`;
    const previewKey = `albums/${albumId}/preview/${name}`;

    if (request.method === "DELETE") {
      const [p0, p1] = await Promise.all([env.BUCKET.get(photoKey), env.BUCKET.get(previewKey)]);
      if (!p0 && !p1) return new Response("Not found", { status: 404 });
      await env.BUCKET.delete([photoKey, previewKey]);
      await invalidateAlbumIndex(env, albumId);
      return ok({ deleted: true, albumId, name });
    }

    const body = await readJson(request);
    if (!body) return badRequest("Bad JSON");
    const newNameRaw = String(body.newName || body.newFilename || "");
    const newName = normalizeJpgName(newNameRaw);
    if (!isValidPhotoFileName(newName)) return badRequest("Invalid newName");
    if (newName === name) return ok({ renamed: true, albumId, from: name, to: newName });

    const newPhotoKey = `albums/${albumId}/photos/${newName}`;
    const newPreviewKey = `albums/${albumId}/preview/${newName}`;

    const [oldPhoto, oldPreview] = await Promise.all([env.BUCKET.get(photoKey), env.BUCKET.get(previewKey)]);
    if (!oldPhoto && !oldPreview) return new Response("Not found", { status: 404 });

    const [dstPhoto, dstPreview] = await Promise.all([env.BUCKET.get(newPhotoKey), env.BUCKET.get(newPreviewKey)]);
    if (dstPhoto || dstPreview) return conflict("Destination name already exists");

    await Promise.all([
      oldPhoto ? copyObject(env.BUCKET, photoKey, newPhotoKey) : Promise.resolve(),
      oldPreview ? copyObject(env.BUCKET, previewKey, newPreviewKey) : Promise.resolve()
    ]);

    await env.BUCKET.delete([photoKey, previewKey]);
    await invalidateAlbumIndex(env, albumId);
    return ok({ renamed: true, albumId, from: name, to: newName });
  }

  // GET /api/admin/albums
  if (path === "/api/admin/albums" && request.method === "GET") {
    const infoKeys = await listAlbumInfoKeys(env);
    const albums = [];

    for (const key of infoKeys) {
      const albumId = key.replace(/^albums\//, "").replace(/\/info\.json$/, "");
      const loaded = await getAlbumInfoWithSecrets(albumId, env);
      const title = loaded.ok ? String(loaded.info?.title || "OhMyPhoto") : "OhMyPhoto";
      const secrets = loaded.ok ? loaded.secrets : [];
      const secretCount = secrets.length;
      albums.push({ albumId, title, secretCount, secrets });
    }

    albums.sort((a, b) => a.albumId.localeCompare(b.albumId));
    return ok({ albums });
  }

  // POST /api/admin/album (create)
  if (path === "/api/admin/album" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return badRequest("Bad JSON");
    const albumId = String(body.albumId || "").trim();
    const title = String(body.title || "OhMyPhoto");

    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

    const existing = await env.BUCKET.get(`albums/${albumId}/info.json`);
    if (existing) return conflict("Album already exists");

    const secret = generateAlbumSecret32();
    const info = { title, secrets: { [secret]: {} } };
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify(info, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    await invalidateAlbumCache(env, albumId);
    await invalidateAlbumIndex(env, albumId);
    // Return secret as a convenience for the UI/caller (still admin-protected).
    return ok({ albumId, title, secret });
  }

  // PUT /api/admin/album/<albumId> (update + optional rename)
  const mUpdate = path.match(/^\/api\/admin\/album\/([^/]+)$/);
  if (mUpdate && request.method === "PUT") {
    const albumId = decodeURIComponent(mUpdate[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");

    const body = await readJson(request);
    if (!body) return badRequest("Bad JSON");

    const newAlbumIdRaw = body.newAlbumId != null ? String(body.newAlbumId || "").trim() : null;
    const newAlbumId = newAlbumIdRaw || null;

    if (newAlbumId && !isValidAlbumId(newAlbumId)) return badRequest("Invalid newAlbumId");

    // load existing info
    const existingInfo = await getInfoJson(env, albumId);
    if (!existingInfo) return new Response("Not found", { status: 404 });

    const nextTitle = body.title != null ? String(body.title || "OhMyPhoto") : String(existingInfo.title || "OhMyPhoto");
    const secretsList = Array.isArray(body.secrets) ? body.secrets : null;
    const nextSecretsObj = secretsList ? normalizeSecretsToObject(secretsList) : (existingInfo.secrets && typeof existingInfo.secrets === "object" ? existingInfo.secrets : {});

    const nextInfo = { ...existingInfo, title: nextTitle, secrets: nextSecretsObj };
    delete nextInfo.secret; // keep one canonical format

    if (newAlbumId && newAlbumId !== albumId) {
      try {
        await renameAlbum(env, albumId, newAlbumId);
      } catch (e) {
        if (e && e.message === "destination_exists") return conflict("Destination album already exists");
        if (e && e.message === "source_missing") return new Response("Not found", { status: 404 });
        return json({ error: "Rename failed" }, 500);
      }

      // write updated info.json under new album id
      await env.BUCKET.put(`albums/${newAlbumId}/info.json`, JSON.stringify(nextInfo, null, 2), {
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      });

      await Promise.all([
        invalidateAlbumCache(env, albumId),
        invalidateAlbumCache(env, newAlbumId)
      ]);
      await Promise.all([
        invalidateAlbumIndex(env, albumId),
        invalidateAlbumIndex(env, newAlbumId)
      ]);
      return ok({ albumId: newAlbumId, title: nextTitle, renamedFrom: albumId });
    }

    // update in place
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify(nextInfo, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    await invalidateAlbumCache(env, albumId);
    await invalidateAlbumIndex(env, albumId);
    return ok({ albumId, title: nextTitle });
  }

  // DELETE /api/admin/album/<albumId>
  const mDel = path.match(/^\/api\/admin\/album\/([^/]+)$/);
  if (mDel && request.method === "DELETE") {
    const albumId = decodeURIComponent(mDel[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const existed = await deleteAlbum(env, albumId);
    await invalidateAlbumCache(env, albumId);
    await invalidateAlbumIndex(env, albumId);
    if (!existed) return new Response("Not found", { status: 404 });
    return ok({ deleted: true, albumId });
  }

  return new Response("Not found", { status: 404 });
}


