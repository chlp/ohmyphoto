import { createTtlCache } from './cache.js';

const albumInfoCache = createTtlCache({ maxEntries: 500, ttlMs: 60_000 });

function extractSecrets(info) {
  const secrets = new Set();
  if (info && typeof info.secret === "string" && info.secret) secrets.add(info.secret);
  if (info && info.secrets && typeof info.secrets === "object") {
    for (const k of Object.keys(info.secrets)) {
      if (k) secrets.add(k);
    }
  }
  return [...secrets];
}

/**
 * Load album info.json and extract all secrets, with an in-memory TTL cache.
 * @param {string} albumId
 * @param {Object} env
 * @returns {Promise<{ok: true, info: any, secrets: string[]} | {ok: false, status: 404|500}>}
 */
export async function getAlbumInfoWithSecrets(albumId, env) {
  const cached = albumInfoCache.get(albumId);
  if (cached) return cached;

  const infoKey = `albums/${albumId}/info.json`;
  const infoObj = await env.BUCKET.get(infoKey);
  if (!infoObj) {
    const res = { ok: false, status: 404 };
    albumInfoCache.set(albumId, res, 15_000); // cache 404 briefly
    return res;
  }

  let info;
  try {
    info = await infoObj.json();
  } catch {
    const res = { ok: false, status: 500 };
    // don't cache parse errors for too long
    albumInfoCache.set(albumId, res, 5_000);
    return res;
  }

  const secrets = extractSecrets(info);
  const res = { ok: true, info, secrets };
  albumInfoCache.set(albumId, res);
  return res;
}

/**
 * Check secret for album using info.json
 * @param {string} albumId
 * @param {string} secret
 * @param {Object} env - Environment с BUCKET
 * @returns {Promise<{success: true, info: Object, matchedSecret: string}|{success: false, response: Response}>}
 */
export async function checkAlbumSecret(albumId, secret, env) {
  const loaded = await getAlbumInfoWithSecrets(albumId, env);
  if (!loaded.ok) {
    return {
      success: false,
      response: new Response(loaded.status === 404 ? "Album not found" : "Bad info.json", { status: loaded.status })
    };
  }

  const info = loaded.info;
  const secrets = new Set(loaded.secrets);
  const providedSecret = String(secret || "");

  if (!providedSecret || !secrets.has(providedSecret)) {
    return {
      success: false,
      response: new Response("Invalid secret", { status: 403 })
    };
  }
  
  return {
    success: true,
    info,
    matchedSecret: providedSecret
  };
}

