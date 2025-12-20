export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname;
  
      // POST /api/album/<albumId>
      const mApi = path.match(/^\/api\/album\/([^/]+)$/);
      if (mApi && request.method === "POST") {
        const albumId = decodeURIComponent(mApi[1]);
  
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }
        const secret = String(body?.secret || "");
  
        // 1) Check if album exists (info.json)
        const infoKey = `albums/${albumId}/info.json`;
        const infoObj = await env.BUCKET.get(infoKey);
        if (!infoObj) return new Response("Not found", { status: 404 });
  
        let info;
        try {
          info = await infoObj.json();
        } catch {
          return new Response("Bad info.json", { status: 500 });
        }
  
        const expected = String(info?.secret || "");
        if (!expected || secret !== expected) {
          return new Response("Forbidden", { status: 403 });
        }
  
        // 2) LIST photos/
        const prefix = `albums/${albumId}/photos/`;
        const listed = await env.BUCKET.list({ prefix });
  
        const files = listed.objects
          .map(o => o.key)
          .filter(k => k !== prefix) // just in case
          .map(k => {
            const name = k.substring(prefix.length);
            // assume preview key: albums/<id>/preview/<name>_preview.jpg (or other)
            // minimally: let preview = albums/<id>/preview/<name>
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
  
      // GET /img/<albumId>/(photos|preview)/<name>
      const mImg = path.match(/^\/img\/([^/]+)\/(photos|preview)\/(.+)$/);
      if (mImg && request.method === "GET") {
        const albumId = decodeURIComponent(mImg[1]);
        const kind = mImg[2];
        const name = decodeURIComponent(mImg[3]);
  
        const key = `albums/${albumId}/${kind}/${name}`;
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response("Not found", { status: 404 });
  
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("ETag", obj.httpEtag);
        headers.set("X-Robots-Tag", "noindex, nofollow");
  
        // minimally: cache for an hour for preview/photo (can be configured)
        headers.set("Cache-Control", kind === "preview"
          ? "public, max-age=86400"
          : "public, max-age=3600"
        );
  
        return new Response(obj.body, { headers });
      }
  
      return new Response("Not found", { status: 404 });
    }
  };
  
  function json(obj, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders
      }
    });
  }