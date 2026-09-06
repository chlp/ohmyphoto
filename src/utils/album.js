import { extractSecrets } from './albumSecrets.js';
import { timingSafeEqual } from './crypto.js';
import { emptyAlbumStats, normalizeAlbumStats } from '../durable/albumInfo.js';

function albumInfoStub(env, albumId) {
  return env.ALBUM_INFO.get(env.ALBUM_INFO.idFromName(`album:${albumId}`));
}

async function albumInfoCall(env, albumId, body) {
  if (!env || !env.ALBUM_INFO) return null;
  const r = await albumInfoStub(env, albumId)
    .fetch(`https://album-info/${body.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}

/** `ALBUM_VIEWS=0` turns view counting off. */
export function albumViewsEnabled(env) {
  return String((env && env.ALBUM_VIEWS) || '1') !== '0';
}

/**
 * Count one successful album open for `secret`. Best-effort: never throws, meant for
 * ctx.waitUntil so the album response does not wait for the Durable Object.
 */
export async function recordAlbumView(env, albumId, secret) {
  if (!albumViewsEnabled(env)) return;
  await albumInfoCall(env, albumId, { action: 'hit', secret }).catch(() => null);
}

/** Full view statistics { since, lastAt, total, bySecret }; empty stats when the DO is unavailable. */
export async function getAlbumStats(env, albumId) {
  const data = await albumInfoCall(env, albumId, { action: 'stats' });
  return data && data.ok === true ? normalizeAlbumStats(data.stats) : emptyAlbumStats();
}

export async function importAlbumStats(env, albumId, stats) {
  await albumInfoCall(env, albumId, { action: 'importStats', stats });
}

export async function resetAlbumStats(env, albumId) {
  await albumInfoCall(env, albumId, { action: 'resetStats' });
}

/** Rename: carry the counters over to the new id and clear them on the old one. Best-effort. */
export async function moveAlbumStats(env, fromAlbumId, toAlbumId) {
  if (!env || !env.ALBUM_INFO || fromAlbumId === toAlbumId) return;
  const stats = await getAlbumStats(env, fromAlbumId);
  if (!stats.total) return;
  await importAlbumStats(env, toAlbumId, stats);
  await resetAlbumStats(env, fromAlbumId);
}

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
 * @param {{ withStats?: boolean }} [opts] withStats: also return the view stats { since, lastAt, total, bySecret }
 *   from the same Durable Object round-trip (admin list); null when the DO is not available.
 * @returns {Promise<{ok: true, info: any, secrets: string[], stats?: object|null} | {ok: false, status: 404|500}>}
 */
export async function getAlbumInfoWithSecrets(albumId, env, opts = {}) {
  const withStats = Boolean(opts.withStats);
  // Prefer persistent DO cache (survives cold starts / isolate restarts).
  if (env && env.ALBUM_INFO) {
    const data = await albumInfoCall(env, albumId, { action: 'get', albumId, withStats });
    if (data) {
      if (data.ok === true && data.info) {
        return {
          ok: true,
          info: data.info,
          secrets: Array.isArray(data.secrets) ? data.secrets : extractSecrets(data.info),
          // Debug/observability hints (non-breaking for existing callers)
          cached: Boolean(data.cached),
          fetchedAtMs: Number(data.fetchedAtMs) || 0,
          stats: withStats && data.stats && typeof data.stats === 'object' ? data.stats : null
        };
      }
      if (data.ok === false && (data.status === 404 || data.status === 500)) {
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
  return { ok: true, info, secrets, cached: false, fetchedAtMs: 0, stats: null };
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

