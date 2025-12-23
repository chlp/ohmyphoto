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
 * Load album info.json and extract all secrets, with an in-memory TTL cache.
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
        return { ok: true, info: data.info, secrets: Array.isArray(data.secrets) ? data.secrets : extractSecrets(data.info) };
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
  return { ok: true, info, secrets };
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

