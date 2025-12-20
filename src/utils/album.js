/**
 * Check secret for album using info.json
 * @param {string} albumId
 * @param {string} secret
 * @param {Object} env - Environment с BUCKET
 * @returns {Promise<{success: true, info: Object}|{success: false, response: Response}>}
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
  
  const expected = String(info?.secret || "");
  const providedSecret = String(secret || "");
  
  if (!expected || providedSecret !== expected) {
    return {
      success: false,
      response: new Response("Invalid secret", { status: 403 })
    };
  }
  
  return {
    success: true,
    info
  };
}

