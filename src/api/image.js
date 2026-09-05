import { imageSig, timingSafeEqual } from '../utils/crypto.js';
import { getAlbumInfoWithSecrets } from '../utils/album.js';
import { forbidden, notFound } from '../utils/response.js';
import { isValidAlbumId } from '../utils/validate.js';
import { imageObjectKey } from '../utils/albumFiles.js';

// Objects are content-addressed and never change, so browsers may cache them for a year.
// Cloudflare edge cache (Cache API, per PoP) 1 day. Trade-off: after a secret rotation,
// already-cached signed URLs keep working at the edge until s-maxage expires. Lower
// IMAGE_EDGE_MAX_AGE_S if faster revocation matters more.
const BROWSER_MAX_AGE_S = 31536000;
const EDGE_MAX_AGE_S = 86400;

function getEdgeCache() {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

/**
 * Handle GET /img/<albumId>/(photos|preview)/<ref>?s=<sig>
 *
 * The object is shared (photos/<ref>.jpg); the signature binds the ref to this album's secret,
 * so access stays per-album. The signature is part of the URL, so a cache hit means this exact
 * URL was already verified; no need to re-load info.json for cached responses. Never lists R2.
 */
export async function handleImageRequest(request, env, albumId, kind, ref, ctx) {
  const url = new URL(request.url);
  const sig = url.searchParams.get('s') || '';

  if (!isValidAlbumId(albumId)) {
    return forbidden();
  }
  const key = imageObjectKey(kind, ref);
  if (!key) {
    return kind === "photos" || kind === "preview" ? forbidden() : notFound();
  }

  // Require signature
  if (!sig) {
    return forbidden();
  }

  const edgeMaxAge = Number(env.IMAGE_EDGE_MAX_AGE_S) || EDGE_MAX_AGE_S;
  const cache = edgeMaxAge > 0 ? getEdgeCache() : null;
  // Normalize the key: drop request headers (Range etc.), keep URL incl. signature.
  const cacheKey = cache ? new Request(url.toString(), { method: 'GET' }) : null;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-OhMyPhoto-Cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  // Validate signature against any secret in info.json (secrets set)
  // (secrets list is cached persistently via Durable Object when enabled)
  const loaded = await getAlbumInfoWithSecrets(albumId, env);
  if (!loaded.ok) {
    return forbidden();
  }

  const secrets = loaded.secrets;
  if (!secrets.length) {
    return forbidden();
  }

  // Check every secret (no early exit) so timing does not reveal which one matched.
  let ok = false;
  for (const secret of secrets) {
    const expected = await imageSig(albumId, ref, secret);
    if (timingSafeEqual(expected, sig)) ok = true;
  }

  if (!ok) {
    return forbidden();
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", `public, max-age=${BROWSER_MAX_AGE_S}, immutable, s-maxage=${edgeMaxAge}`);
  headers.set("X-OhMyPhoto-Cache", "MISS");

  const response = new Response(obj.body, { headers });

  if (cache) {
    const put = cache.put(cacheKey, response.clone()).catch(() => null);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
  }

  return response;
}
