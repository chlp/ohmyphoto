import { json } from '../utils/response.js';
import { getAlbumInfoWithSecrets } from '../utils/album.js';
import { invalidateAlbumCache } from '../utils/album.js';
import { issueAdminSessionToken, verifyAdminSessionToken } from '../utils/session.js';

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

  // Allow using the raw ADMIN_TOKEN for non-browser tooling (curl/scripts)
  if (token === expected) return null;

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

function isValidAlbumId(albumId) {
  // keep it simple: URL/path safe
  return /^[a-zA-Z0-9_-]{1,64}$/.test(albumId);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
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

async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor = undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.cursor;
  } while (cursor);
  return keys;
}

async function copyObject(env, fromKey, toKey) {
  const obj = await env.BUCKET.get(fromKey);
  if (!obj) return;

  // Best-effort preserve metadata when available
  const opts = {};
  if (obj.httpMetadata) opts.httpMetadata = obj.httpMetadata;
  if (obj.customMetadata) opts.customMetadata = obj.customMetadata;

  await env.BUCKET.put(toKey, obj.body, opts);
}

async function renameAlbum(env, oldAlbumId, newAlbumId) {
  const oldPrefix = `albums/${oldAlbumId}/`;
  const newPrefix = `albums/${newAlbumId}/`;

  // Ensure destination does not exist
  const exists = await env.BUCKET.get(`${newPrefix}info.json`);
  if (exists) {
    throw new Error("destination_exists");
  }

  const keys = await listAllKeys(env, oldPrefix);
  if (!keys.length) {
    throw new Error("source_missing");
  }

  for (const key of keys) {
    const newKey = newPrefix + key.substring(oldPrefix.length);
    await copyObject(env, key, newKey);
  }

  // Delete old after copy
  for (let i = 0; i < keys.length; i += 100) {
    await env.BUCKET.delete(keys.slice(i, i + 100));
  }
}

async function deleteAlbum(env, albumId) {
  const prefix = `albums/${albumId}/`;
  const keys = await listAllKeys(env, prefix);
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
    const expected = String(env.ADMIN_TOKEN || "");
    if (!expected) return unauthorized();
    if (!provided || provided !== expected) return unauthorized();

    const issued = await issueAdminSessionToken(expected);
    return ok({ sessionToken: issued.token, iat: issued.payload.iat, exp: issued.payload.exp });
  }

  const authErr = await authorizeAdmin(request, env);
  if (authErr) return authErr;

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

    const info = { title, secrets: {} };
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify(info, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    invalidateAlbumCache(albumId);
    return ok({ albumId, title });
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

      invalidateAlbumCache(albumId);
      invalidateAlbumCache(newAlbumId);
      return ok({ albumId: newAlbumId, title: nextTitle, renamedFrom: albumId });
    }

    // update in place
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify(nextInfo, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    invalidateAlbumCache(albumId);
    return ok({ albumId, title: nextTitle });
  }

  // DELETE /api/admin/album/<albumId>
  const mDel = path.match(/^\/api\/admin\/album\/([^/]+)$/);
  if (mDel && request.method === "DELETE") {
    const albumId = decodeURIComponent(mDel[1]);
    if (!isValidAlbumId(albumId)) return badRequest("Invalid albumId");
    const existed = await deleteAlbum(env, albumId);
    invalidateAlbumCache(albumId);
    if (!existed) return new Response("Not found", { status: 404 });
    return ok({ deleted: true, albumId });
  }

  return new Response("Not found", { status: 404 });
}


