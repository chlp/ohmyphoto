import { checkAlbumSecret } from '../utils/album.js';
import { json } from '../utils/response.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';
import { imageSig } from '../utils/crypto.js';

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
  const turnstileToken = String(body?.turnstileToken || "");

  // Verify Turnstile token if secret key is configured
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      return new Response("Bot verification required", { status: 403 });
    }
    const clientIP = request.headers.get('CF-Connecting-IP') || null;
    const turnstileResult = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET_KEY, clientIP);
    if (!turnstileResult.success) {
      return new Response("Bot verification failed", { status: 403 });
    }
  }

  // Check if album exists and secret is valid
  const checkResult = await checkAlbumSecret(albumId, secret, env);
  if (!checkResult.success) {
    return checkResult.response;
  }
  const info = checkResult.info;
  const matchedSecret = checkResult.matchedSecret;

  // LIST photos/
  const prefix = `albums/${albumId}/photos/`;
  const listed = await env.BUCKET.list({ prefix });

  const files = listed.objects
    .map(o => o.key)
    .filter(k => k !== prefix) // just in case
    .map(async (k) => {
      const name = k.substring(prefix.length);
      const sig = await imageSig(albumId, name, matchedSecret);
      const qs = `?s=${sig}`;
      return {
        name,
        photoUrl: `/img/${encodeURIComponent(albumId)}/photos/${encodeURIComponent(name)}${qs}`,
        previewUrl: `/img/${encodeURIComponent(albumId)}/preview/${encodeURIComponent(name)}${qs}`
      };
    });

  const resolvedFiles = await Promise.all(files);

  const resp = {
    albumId,
    title: String(info?.title || ""),
    files: resolvedFiles
  };

  return json(resp, 200, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer"
  });
}

