import { imageSig } from '../utils/crypto.js';
import { getAlbumInfoWithSecrets } from '../utils/album.js';
import { forbidden, notFound } from '../utils/response.js';
import { isValidAlbumId, isValidPhotoFileName } from '../utils/validate.js';

/**
 * Handle GET /img/<albumId>/(photos|preview)/<name>
 */
export async function handleImageRequest(request, env, albumId, kind, name) {
  const url = new URL(request.url);
  const sig = url.searchParams.get('s') || '';

  // Defensive validation (router already constrains kind; still validate inputs here).
  if (!isValidAlbumId(albumId)) {
    return forbidden();
  }
  if (kind !== "photos" && kind !== "preview") {
    return notFound();
  }
  if (!isValidPhotoFileName(name)) {
    return forbidden();
  }

  // Require signature
  if (!sig) {
    return forbidden();
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

  let ok = false;
  for (const secret of secrets) {
    const expected = await imageSig(albumId, name, secret);
    if (expected === sig) {
      ok = true;
      break;
    }
  }

  if (!ok) {
    return forbidden();
  }

  const key = `albums/${albumId}/${kind}/${name}`;
  const obj = await env.BUCKET.get(key);
  if (!obj) return notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(obj.body, { headers });
}

