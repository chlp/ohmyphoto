/**
 * Check secret for album using info.json
 * @param {string} albumId
 * @param {string} secret
 * @param {Object} env - Environment с BUCKET
 * @returns {Promise<{success: true, info: Object, matchedSecret: string}|{success: false, response: Response}>}
 */
export async function checkAlbumSecret(albumId, secret, env) {
  const infoKey = `albums/${albumId}/info.json`;
  const infoObj = await env.BUCKET.get(infoKey);
  
  if (!infoObj) {
    return {
      success: false,
      response: new Response("Album not found", { status: 404 })
    };
  }
  
  let info;
  try {
    info = await infoObj.json();
  } catch {
    return {
      success: false,
      response: new Response("Bad info.json", { status: 500 })
    };
  }
  
  const providedSecret = String(secret || "");

  // Support both formats:
  // - info.secret: "..."
  // - info.secrets: { "<secret1>": {}, "<secret2>": {} }
  const secrets = new Set();
  if (info && typeof info.secret === "string" && info.secret) secrets.add(info.secret);
  if (info && info.secrets && typeof info.secrets === "object") {
    for (const k of Object.keys(info.secrets)) {
      if (k) secrets.add(k);
    }
  }

  if (!providedSecret || !secrets.has(providedSecret)) {
    return {
      success: false,
      response: new Response("Invalid secret", { status: 403 })
    };
  }
  
  return {
    success: true,
    info,
    matchedSecret: providedSecret
  };
}

