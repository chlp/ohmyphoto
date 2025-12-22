/**
 * Shared validation helpers (keep pure + reusable across Worker/DO/API).
 */

export function isValidAlbumId(albumId) {
  // keep it simple: URL/path safe
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(albumId || ""));
}

export function normalizeJpgName(input) {
  let name = String(input || "").trim();
  if (!name) return "";
  // Drop any path components (defense-in-depth)
  name = name.replace(/^.*[\\/]/, "");
  // Ensure .jpg extension
  if (!/\.jpe?g$/i.test(name)) {
    name = name.replace(/\.[^.]+$/, ""); // strip one extension if present
    name = `${name}.jpg`;
  } else {
    name = name.replace(/\.jpeg$/i, ".jpg");
  }
  return name;
}

export function isValidPhotoFileName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (n.length > 160) return false;
  if (n.includes("/") || n.includes("\\") || n.includes("\0")) return false;
  if (n.startsWith(".")) return false;
  // predictable + URL-safe-ish (space allowed for convenience)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(n)) return false;
  if (!/\.jpg$/i.test(n)) return false;
  return true;
}


