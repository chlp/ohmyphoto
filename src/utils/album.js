import { extractSecrets } from './albumSecrets.js';
import { timingSafeEqual } from './crypto.js';

export async function invalidateAlbumCache(env, albumId) {
  // Best-effort: clear persistent cache in Durable Object (if configured)
  if (!env || !env.ALBUM_INFO) return;
  const stub = env.ALBUM_INFO.get(env.ALBUM_INFO.idFromName(`album:${albumId}`));
  await stub
    .fetch('https://album-info/invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'invalidate' })
    })
    .catch(() => null);
}

/**
 * Load album info.json and extract all secrets.
 * @param {string} albumId
 * @param {Object} env
 * @returns {Promise<{ok: true, info: any, secrets: string[]} | {ok: false, status: 404|500}>}
 */
export async function getAlbumInfoWithSecrets(albumId, env) {
  // Prefer persistent DO cache (survives cold starts / isolate restarts).
  if (env && env.ALBUM_INFO) {
    const stub = env.ALBUM_INFO.get(env.ALBUM_INFO.idFromName(`album:${albumId}`));
    const r = await stub
      .fetch('https://album-info/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', albumId })
      })
      .catch(() => null);
    if (r && r.ok) {
      const data = await r.json().catch(() => null);
      if (data && data.ok === true && data.info) {
        return {
          ok: true,
          info: data.info,
          secrets: Array.isArray(data.secrets) ? data.secrets : extractSecrets(data.info),
          // Debug/observability hints (non-breaking for existing callers)
          cached: Boolean(data.cached),
          fetchedAtMs: Number(data.fetchedAtMs) || 0
        };
      }
      if (data && data.ok === false && (data.status === 404 || data.status === 500)) {
        return { ok: false, status: data.status };
      }
      // fall through on unexpected response
    }
  }

  const infoKey = `albums/${albumId}/info.json`;
  const infoObj = await env.BUCKET.get(infoKey);
  if (!infoObj) {
    return { ok: false, status: 404 };
  }

  let info;
  try {
    info = await infoObj.json();
  } catch {
    return { ok: false, status: 500 };
  }

  const secrets = extractSecrets(info);
  return { ok: true, info, secrets, cached: false, fetchedAtMs: 0 };
}

/**
 * Check secret for album using info.json
 * @param {string} albumId
 * @param {string} secret
 * @param {Object} env - Environment with BUCKET
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
  const providedSecret = String(secret || "");

  // Compare against every secret without early exit so timing does not reveal which one matched.
  let matched = false;
  for (const s of loaded.secrets) {
    if (timingSafeEqual(s, providedSecret)) matched = true;
  }

  if (!providedSecret || !matched) {
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

