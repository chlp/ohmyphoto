/**
 * Shared validation helpers (keep pure + reusable across Worker/DO/API).
 */

export function isValidAlbumId(albumId) {
  // keep it simple: URL/path safe
  // Allow dots for date-prefixed ids like "2025.12.25-sunny-family-beach"
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(String(albumId || ""));
}

export function isValidAlbumSecret(secret) {
  // Secret is used verbatim in the URL hash (see admin UI), so keep it URL-fragment safe.
  // Use a permissive but safe charset to avoid encoding/decoding mismatches.
  return /^[a-zA-Z0-9_-]{1,256}$/.test(String(secret || ""));
}

export function normalizeJpgName(input) {
  let name = String(input || "").trim();
  if (!name) return "";
  // Drop any path components (defense-in-depth)
  name = name.replace(/^.*[\\/]/, "");
  // Ensure jpeg extension (.jpg or .jpeg). Keep existing .jpg/.jpeg to match R2 keys.
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg")) {
    name = name.slice(0, -4) + ".jpg";
  } else if (lower.endsWith(".jpeg")) {
    name = name.slice(0, -5) + ".jpeg";
  } else if (/\.[^.]+$/.test(name)) {
    // Replace any other extension with .jpg
    name = name.replace(/\.[^.]+$/, ".jpg");
  } else {
    // No extension -> default to .jpg
    name = `${name}.jpg`;
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
  if (!/\.jpe?g$/i.test(n)) return false;
  return true;
}


