import { imageSig } from '../utils/crypto.js';

async function loadAlbumInfo(env, albumId) {
  const infoKey = `albums/${albumId}/info.json`;
  const infoObj = await env.BUCKET.get(infoKey);
  if (!infoObj) return null;
  try {
    return await infoObj.json();
  } catch {
    return null;
  }
}

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
 * Handle GET /img/<albumId>/(photos|preview)/<name>
 */
export async function handleImageRequest(request, env, albumId, kind, name) {
  const url = new URL(request.url);
  const sig = url.searchParams.get('s') || '';

  // Require signature
  if (!sig) {
    return new Response("Forbidden", { status: 403 });
  }

  // Validate signature against any secret in info.json (secrets set)
  const info = await loadAlbumInfo(env, albumId);
  const secrets = extractSecrets(info);
  if (!secrets.length) {
    return new Response("Forbidden", { status: 403 });
  }

  let ok = false;
  for (const secret of secrets) {
    // Requested format: hash(albumId + name + secret) (we use a delimiter to avoid ambiguity)
    const expected = await imageSig(albumId, name, secret);
    if (expected === sig) {
      ok = true;
      break;
    }
  }

  if (!ok) {
    return new Response("Forbidden", { status: 403 });
  }

  const key = `albums/${albumId}/${kind}/${name}`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(obj.body, { headers });
}

