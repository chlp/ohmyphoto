import { checkAlbumSecret } from '../utils/album.js';
import { json } from '../utils/response.js';

/**
 * Handle POST /api/album/<albumId>
 */
export async function handleAlbumRequest(request, env, albumId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const secret = String(body?.secret || "");

  // Check if album exists and secret is valid
  const checkResult = await checkAlbumSecret(albumId, secret, env);
  if (!checkResult.success) {
    return checkResult.response;
  }
  const info = checkResult.info;

  // LIST photos/
  const prefix = `albums/${albumId}/photos/`;
  const listed = await env.BUCKET.list({ prefix });

  const files = listed.objects
    .map(o => o.key)
    .filter(k => k !== prefix) // just in case
    .map(k => {
      const name = k.substring(prefix.length);
      return {
        name,
        photoUrl: `/img/${encodeURIComponent(albumId)}/photos/${encodeURIComponent(name)}`,
        previewUrl: `/img/${encodeURIComponent(albumId)}/preview/${encodeURIComponent(name)}`
      };
    });

  const resp = {
    albumId,
    title: String(info?.title || ""),
    files
  };

  return json(resp, 200, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer"
  });
}

