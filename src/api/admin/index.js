import { notFound } from '../../utils/response.js';
import { authorizeAdmin, handleSession } from './auth.js';
import { handleGenerateAlbumId } from './ai.js';
import { handleCreateAlbum, handleDeleteAlbum, handleListAlbums, handleUpdateAlbum } from './albums.js';
import {
  handleAttachFiles,
  handleDeleteFile,
  handleListFiles,
  handlePhotoExists,
  handleRawImage,
  handleRenameFile,
  handleUploadFile,
  handleVerifyFiles
} from './files.js';
import { handleGcPhotos } from './gc.js';
import { handleDeleteTrash, handleListTrash, handleRestoreTrash } from './trash.js';

/**
 * Admin route table. Patterns are matched against the full pathname; capture groups are
 * URL-decoded and passed to the handler as `params` (in order).
 * Every route except `public: true` requires a Bearer session token.
 */
const ROUTES = [
  { method: "POST", pattern: /^\/api\/admin\/session$/, handler: handleSession, public: true },
  { method: "POST", pattern: /^\/api\/admin\/generate-album-id$/, handler: handleGenerateAlbumId },

  { method: "GET", pattern: /^\/api\/admin\/albums$/, handler: handleListAlbums },

  { method: "GET", pattern: /^\/api\/admin\/trash$/, handler: handleListTrash },
  { method: "POST", pattern: /^\/api\/admin\/trash\/restore$/, handler: handleRestoreTrash },
  { method: "DELETE", pattern: /^\/api\/admin\/trash\/(.+)$/, handler: handleDeleteTrash },

  { method: "GET", pattern: /^\/api\/admin\/photo\/([^/]+)$/, handler: handlePhotoExists },
  { method: "POST", pattern: /^\/api\/admin\/photos\/gc$/, handler: handleGcPhotos },

  { method: "POST", pattern: /^\/api\/admin\/album$/, handler: handleCreateAlbum },
  { method: "PUT", pattern: /^\/api\/admin\/album\/([^/]+)$/, handler: handleUpdateAlbum },
  { method: "DELETE", pattern: /^\/api\/admin\/album\/([^/]+)$/, handler: handleDeleteAlbum },

  { method: "POST", pattern: /^\/api\/admin\/album\/([^/]+)\/verify-files$/, handler: handleVerifyFiles },
  { method: "GET", pattern: /^\/api\/admin\/album\/([^/]+)\/files$/, handler: handleListFiles },
  { method: "POST", pattern: /^\/api\/admin\/album\/([^/]+)\/files$/, handler: handleAttachFiles },
  { method: "GET", pattern: /^\/api\/admin\/album\/([^/]+)\/raw\/(photos|preview)\/([^/]+)$/, handler: handleRawImage },
  { method: "POST", pattern: /^\/api\/admin\/album\/([^/]+)\/file$/, handler: handleUploadFile },
  { method: "PUT", pattern: /^\/api\/admin\/album\/([^/]+)\/file\/(.+)$/, handler: handleRenameFile },
  { method: "DELETE", pattern: /^\/api\/admin\/album\/([^/]+)\/file\/(.+)$/, handler: handleDeleteFile }
];

/**
 * Handle /api/admin/*
 */
export async function handleAdminRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  for (const route of ROUTES) {
    if (route.method !== request.method) continue;
    const m = path.match(route.pattern);
    if (!m) continue;

    if (!route.public) {
      const authErr = await authorizeAdmin(request, env);
      if (authErr) return authErr;
    }

    const params = m.slice(1).map((p) => decodeURIComponent(p));
    return route.handler({ request, env, url, params });
  }

  // Unknown admin path: still require auth so route existence is not leaked.
  const authErr = await authorizeAdmin(request, env);
  if (authErr) return authErr;
  return notFound();
}
