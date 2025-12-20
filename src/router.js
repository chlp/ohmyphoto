import { handleAlbumRequest } from './api/album.js';
import { handleImageRequest } from './api/image.js';
import { handleAdminRequest } from './api/admin.js';

/**
 * Router for handling different routes
 */
export async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // /api/admin/*
  if (path.startsWith("/api/admin/")) {
    return handleAdminRequest(request, env);
  }

  // POST /api/album/<albumId>
  const mApi = path.match(/^\/api\/album\/([^/]+)$/);
  if (mApi && request.method === "POST") {
    const albumId = decodeURIComponent(mApi[1]);
    return handleAlbumRequest(request, env, albumId);
  }

  // GET /img/<albumId>/(photos|preview)/<name>
  const mImg = path.match(/^\/img\/([^/]+)\/(photos|preview)\/(.+)$/);
  if (mImg && request.method === "GET") {
    const albumId = decodeURIComponent(mImg[1]);
    const kind = mImg[2];
    const name = decodeURIComponent(mImg[3]);
    return handleImageRequest(request, env, albumId, kind, name);
  }

  // 404 for unmatched routes
  return new Response("Not found", { status: 404 });
}

