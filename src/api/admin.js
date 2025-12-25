import { json } from '../utils/response.js';
import { getAlbumInfoWithSecrets, invalidateAlbumCache } from '../utils/album.js';
import { timingSafeEqual } from '../utils/crypto.js';
import { issueAdminSessionToken, verifyAdminSessionToken } from '../utils/session.js';
import { requireTurnstileOr403 } from '../utils/turnstile.js';
import { isValidAlbumId, isValidAlbumSecret, isValidPhotoFileName, normalizeJpgName } from '../utils/validate.js';
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

function formatDatePrefixUtc(d = new Date()) {
  // YYYY.MM.DD-
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}-`;
}

function normalizeAiSlugToAlbumId(raw) {
  // take first line, strip quotes, enforce lowercase + kebab-case
  const firstLine = String(raw || "").split(/\r?\n/)[0] || "";
  let s = firstLine.trim();
  // drop wrapping quotes/backticks
  s = s.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  s = s.toLowerCase();
  // replace invalid chars with hyphen, then collapse
  s = s.replace(/[^a-z-]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return s;
}

function isValidAiSlugAlbumId(slug) {
  const s = String(slug || "");
  if (!/^[a-z-]{1,128}$/.test(s)) return false;
  const words = s.split("-").filter(Boolean);
  if (words.length < 3 || words.length > 4) return false;
  // albumId validator allows underscores/digits too, but AI spec is letters+hyphens only
  return true;
}

function normalizeAiTitle(raw) {
  // take first line, strip quotes/backticks, collapse whitespace
  const firstLine = String(raw || "").split(/\r?\n/)[0] || "";
  let s = firstLine.trim();
  s = s.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  // Remove control chars
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  // guard against absurd output
  if (s.length > 80) s = s.slice(0, 80).trim();
  // avoid trailing punctuation-only titles
  s = s.replace(/^[\s\-–—:;,.!?]+/, "").replace(/[\s\-–—:;,.!?]+$/, "").trim();
  return s;
}

async function generateAlbumIdViaAi(env, description) {
  if (!env || !env.AI) {
    return { ok: false, status: 501, error: "Workers AI is not configured (missing AI binding)" };
  }

  const desc = String(description || "").trim();
  if (!desc) return { ok: false, status: 400, error: "Missing description" };
  if (desc.length > 500) return { ok: false, status: 400, error: "Description too long" };

  const datePrefix = formatDatePrefixUtc(new Date());
  const maxTotalLen = 128;
  const maxSlugLen = Math.max(1, maxTotalLen - datePrefix.length);

  const basePrompt =
    `${desc}\n\n` +
    `Generate a short English slug (3–4 words) in kebab-case.\n` +
    `Output must be a single line with only lowercase letters a-z and hyphens.\n` +
    `Include exactly 1 pleasant vivid adjective as one of the words.\n` +
    `No extra text.`;

  // Prefer a faster/smaller model by default; can be overridden via AI_ALBUM_ID_MODEL.
  const model = String(env.AI_ALBUM_ID_MODEL || "").trim() || "@cf/meta/llama-2-7b-chat-int8";
  const maxTokensRaw = Number(env.AI_ALBUM_ID_MAX_TOKENS);
  const max_tokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.min(64, Math.floor(maxTokensRaw)) : 16;
  const tempRaw = Number(env.AI_ALBUM_ID_TEMPERATURE);
  const temperature = Number.isFinite(tempRaw) ? Math.min(1, Math.max(0, tempRaw)) : 0.2;
  const topPRaw = Number(env.AI_ALBUM_ID_TOP_P);
  const top_p = Number.isFinite(topPRaw) ? Math.min(1, Math.max(0.1, topPRaw)) : 0.9;

  // Try twice: second attempt is stricter if model misbehaves.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nIMPORTANT: Return exactly 3 or 4 words, joined by single hyphens. Include exactly 1 pleasant adjective. Do NOT include quotes, punctuation, numbers, or additional lines.`;

    let out;
    try {
      // Chat-style models in Workers AI accept { messages: [...] }
      out = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        temperature,
        top_p
      });
    } catch (e) {
      return { ok: false, status: 502, error: "AI generation failed" };
    }

    const raw =
      typeof out === "string" ? out :
        (out && typeof out.response === "string") ? out.response :
          (out && out.result && typeof out.result.response === "string") ? out.result.response :
            JSON.stringify(out || "");

    let slug = normalizeAiSlugToAlbumId(raw);
    if (slug.length > maxSlugLen) slug = slug.slice(0, maxSlugLen).replace(/-+$/g, "");
    if (isValidAiSlugAlbumId(slug)) {
      // Ensure it also passes the app's albumId validation (slugs should).
      const albumId = `${datePrefix}${slug}`;
      if (!isValidAlbumId(albumId)) {
        return { ok: false, status: 502, error: "AI output did not produce a valid albumId" };
      }
      return { ok: true, albumId, raw: String(raw || "") };
    }
  }

  return { ok: false, status: 502, error: "AI returned an invalid slug" };
}

async function generateAlbumTitleViaAi(env, description) {
  if (!env || !env.AI) {
    return { ok: false, status: 501, error: "Workers AI is not configured (missing AI binding)" };
  }

  const desc = String(description || "").trim();
  if (!desc) return { ok: false, status: 400, error: "Missing description" };
  if (desc.length > 500) return { ok: false, status: 400, error: "Description too long" };

  const basePrompt =
    `${desc}\n\n` +
    `Generate a short, human-friendly album title (2–6 words).\n` +
    `- Output MUST be in English.\n` +
    `- Do NOT include a date.\n` +
    `- Output must be a single line.\n` +
    `- No quotes, no extra text.`;

  const model = String(env.AI_ALBUM_TITLE_MODEL || "").trim()
    || String(env.AI_ALBUM_ID_MODEL || "").trim()
    || "@cf/meta/llama-2-7b-chat-int8";

  const maxTokensRaw = Number(env.AI_ALBUM_TITLE_MAX_TOKENS);
  const max_tokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.min(96, Math.floor(maxTokensRaw)) : 24;
  const tempRaw = Number(env.AI_ALBUM_TITLE_TEMPERATURE);
  const temperature = Number.isFinite(tempRaw) ? Math.min(1, Math.max(0, tempRaw)) : 0.3;
  const topPRaw = Number(env.AI_ALBUM_TITLE_TOP_P);
  const top_p = Number.isFinite(topPRaw) ? Math.min(1, Math.max(0.1, topPRaw)) : 0.9;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nIMPORTANT: Return only the title text on one line. No punctuation-only output.`;

    let out;
    try {
      out = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        temperature,
        top_p
      });
    } catch (e) {
      return { ok: false, status: 502, error: "AI generation failed" };
    }

    const raw =
      typeof out === "string" ? out :
        (out && typeof out.response === "string") ? out.response :
          (out && out.result && typeof out.result.response === "string") ? out.result.response :
            JSON.stringify(out || "");

    const title = normalizeAiTitle(raw);
    if (title) return { ok: true, title, raw: String(raw || "") };
  }

  return { ok: false, status: 502, error: "AI returned an empty title" };
}

function randomHex(bytesLen) {
  const bytes = new Uint8Array(bytesLen);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function generateAlbumSecret6() {
  // 3 bytes => 6 hex chars
  return randomHex(3);
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

async function putInfoJson(env, albumId, info) {
  await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify(info, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  await invalidateAlbumCache(env, albumId);
}

function getFilesFromInfo(info) {
  const raw = info && Array.isArray(info.files) ? info.files : [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    const name = String(f || "").trim();
    if (!name) continue;
    if (!isValidPhotoFileName(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function upsertInfoFile(info, name) {
  const files = getFilesFromInfo(info);
  if (!files.includes(name)) files.push(name);
  files.sort((a, b) => a.localeCompare(b));
  return { ...(info && typeof info === "object" ? info : {}), files };
}

function removeInfoFile(info, name) {
  const files = getFilesFromInfo(info).filter((n) => n !== name);
  return { ...(info && typeof info === "object" ? info : {}), files };
}

function renameInfoFile(info, from, to) {
  const files = getFilesFromInfo(info);
  const next = files.map((n) => (n === from ? to : n));
  const uniq = [];
  const seen = new Set();
  for (const n of next) {
    if (seen.has(n)) continue;
    seen.add(n);
    uniq.push(n);
  }
  uniq.sort((a, b) => a.localeCompare(b));
  return { ...(info && typeof info === "object" ? info : {}), files: uniq };
}

async function listAlbumPhotoNamesFromBucket(env, albumId) {
  const photosPrefix = `albums/${albumId}/photos/`;
  const keys = await listAllKeys(env.BUCKET, photosPrefix);
  return keys
    .filter((k) => k !== photosPrefix)
    .map((k) => k.substring(photosPrefix.length))
    .filter((n) => isValidPhotoFileName(n))
    .sort((a, b) => a.localeCompare(b));
}

async function listAlbumPreviewSetFromBucket(env, albumId) {
  const previewPrefix = `albums/${albumId}/preview/`;
  const keys = await listAllKeys(env.BUCKET, previewPrefix);
  return new Set(
    keys
      .filter((k) => k !== previewPrefix)
      .map((k) => k.substring(previewPrefix.length))
      .filter((n) => isValidPhotoFileName(n))
  );
}

async function rebuildAlbumFilesList(env, albumId) {
  const info = await getInfoJson(env, albumId);
  if (!info) return { ok: false, status: 404, error: 'Not found' };

  const prev = getFilesFromInfo(info);
  const names = await listAlbumPhotoNamesFromBucket(env, albumId);
  const previewSet = await listAlbumPreviewSetFromBucket(env, albumId);
  const missingPreview = names.filter((n) => !previewSet.has(n));

  const nextInfo = { ...(info && typeof info === "object" ? info : {}), files: names };
  await putInfoJson(env, albumId, nextInfo);

  const prevSet = new Set(prev);
  const nextSet = new Set(names);
  const added = names.filter((n) => !prevSet.has(n));
  const removed = prev.filter((n) => !nextSet.has(n));
  return {
    ok: true,
    albumId,
    fileCount: names.length,
    added,
    removed,
    missingPreviewCount: missingPreview.length
  };
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
      const turnstileTimeoutMs = Number(env.TURNSTILE_VERIFY_TIMEOUT_MS) || 5000;
      const err = await requireTurnstileOr403(request, {
        token: turnstileToken,
        secretKey: env.TURNSTILE_SECRET_KEY,
        timeoutMs: turnstileTimeoutMs,
        messageRequired: "Bot verification required",
        messageFailed: "Bot verification failed"
      });
      if (err) return err;
    }

    if (!provided || !timingSafeEqual(provided, expected)) return unauthorized();

    const issued = await issueAdminSessionToken(expected);
    return ok({ sessionToken: issued.token, iat: issued.payload.iat, exp: issued.payload.exp });
  }

  const authErr = await authorizeAdmin(request, env);
  if (authErr) return authErr;

  // POST /api/admin/generate-album-id (Workers AI)
  if (path === "/api/admin/generate-album-id" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return badRequest("Bad JSON");
    const description = String(body.description || body.text || body.prompt || "").trim();
    const r = await generateAlbumIdViaAi(env, description);
    if (!r.ok) return json({ error: r.error }, r.status || 500, { "Cache-Control": "no-store" });
    // Best-effort title generation: albumId is the primary requirement.
    const t = await generateAlbumTitleViaAi(env, description);
    return ok({ albumId: r.albumId, title: t && t.ok ? t.title : "" });
  }

  // POST /api/admin/album/<albumId>/rebuild-files
  const mRebuild = path.match(/^\/api\/admin\/album\/([^/]+)\/rebuild-files$/);
  if (mRebuild && request.method === "POST") {
    const albumId = decodeURIComponent(mRebuild[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const r = await rebuildAlbumFilesList(env, albumId);
    if (!r.ok) return new Response("Not found", { status: 404 });
    return ok(r);
  }

  // POST /api/admin/albums/rebuild-files (all albums)
  if (path === "/api/admin/albums/rebuild-files" && request.method === "POST") {
    const infoKeys = await listAlbumInfoKeys(env);
    const albumIds = infoKeys
      .map((key) => key.replace(/^albums\//, "").replace(/\/info\.json$/, ""))
      .filter((id) => isValidAlbumId(id))
      .sort((a, b) => a.localeCompare(b));

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
      } catch (e) {
        albumsErr += 1;
        results.push({ ok: false, albumId, status: 500, error: 'rebuild_failed' });
      }
    }

    return ok({
      ok: true,
      albumCount: albumIds.length,
      albumsOk,
      albumsErr,
      totalFiles,
      totalMissingPreview,
      results
    });
  }

  // GET /api/admin/album/<albumId>/files
  const mFiles = path.match(/^\/api\/admin\/album\/([^/]+)\/files$/);
  if (mFiles && request.method === "GET") {
    const albumId = decodeURIComponent(mFiles[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const info = await getInfoJson(env, albumId);
    if (!info) return new Response("Not found", { status: 404 });
    const names = getFilesFromInfo(info);
    const files = names.map((name) => ({
      name,
      hasPreview: true,
      photoUrl: `/api/admin/album/${encodeURIComponent(albumId)}/raw/photos/${encodeURIComponent(name)}`,
      previewUrl: `/api/admin/album/${encodeURIComponent(albumId)}/raw/preview/${encodeURIComponent(name)}`
    }));
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

    const info = await getInfoJson(env, albumId);
    if (!info) return json({ error: "Missing info.json" }, 500);
    const nextInfo = upsertInfoFile(info, name);
    await putInfoJson(env, albumId, nextInfo);
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
      const info = await getInfoJson(env, albumId);
      if (info) {
        const nextInfo = removeInfoFile(info, name);
        await putInfoJson(env, albumId, nextInfo);
      } else {
        await invalidateAlbumCache(env, albumId);
      }
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
    const info = await getInfoJson(env, albumId);
    if (info) {
      const nextInfo = renameInfoFile(info, name, newName);
      await putInfoJson(env, albumId, nextInfo);
    } else {
      await invalidateAlbumCache(env, albumId);
    }
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
    const secretIn = body.secret != null ? String(body.secret || "").trim() : "";

    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    if (secretIn && !isValidAlbumSecret(secretIn)) return badRequest("Invalid secret");

    const existing = await env.BUCKET.get(`albums/${albumId}/info.json`);
    if (existing) return conflict("Album already exists");

    const secret = secretIn || generateAlbumSecret6();
    const info = { title, secrets: { [secret]: {} }, files: [] };
    await putInfoJson(env, albumId, info);
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
      return ok({ albumId: newAlbumId, title: nextTitle, renamedFrom: albumId });
    }

    // update in place
    await putInfoJson(env, albumId, nextInfo);
    return ok({ albumId, title: nextTitle });
  }

  // DELETE /api/admin/album/<albumId>
  const mDel = path.match(/^\/api\/admin\/album\/([^/]+)$/);
  if (mDel && request.method === "DELETE") {
    const albumId = decodeURIComponent(mDel[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const existed = await deleteAlbum(env, albumId);
    await invalidateAlbumCache(env, albumId);
    if (!existed) return new Response("Not found", { status: 404 });
    return ok({ deleted: true, albumId });
  }

  return new Response("Not found", { status: 404 });
}


