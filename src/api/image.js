import { imageSig } from '../utils/crypto.js';
import { getAlbumInfoWithSecrets } from '../utils/album.js';

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
  // (secrets list is cached in-memory inside getAlbumInfoWithSecrets)
  const loaded = await getAlbumInfoWithSecrets(albumId, env);
  if (!loaded.ok) {
    return new Response("Forbidden", { status: 403 });
  }

  const secrets = loaded.secrets;
  if (!secrets.length) {
    return new Response("Forbidden", { status: 403 });
  }

  let ok = false;
  for (const secret of secrets) {
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

