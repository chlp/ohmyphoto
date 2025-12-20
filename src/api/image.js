/**
 * Handle GET /img/<albumId>/(photos|preview)/<name>
 */
export async function handleImageRequest(request, env, albumId, kind, name) {
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

