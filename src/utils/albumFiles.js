import { isValidPhotoFileName } from './validate.js';

/**
 * `info.json.files` entries: { name: "001_beach.jpg", ref: "<sha256 hex>", size?: <bytes> }
 *
 * Photos are stored once, content-addressed, and shared across albums:
 *   photos/<ref>.jpg     original
 *   previews/<ref>.jpg   preview
 * `name` is the display/download name and is unique within an album; `ref` is the storage
 * identity (SHA-256 of the source file). `size` is the byte size of the original object,
 * recorded on upload/attach/verify and used by the gallery's "download all as ZIP" gate
 * (see src/utils/albumZip.js). The array order is the gallery order (admin writes keep it
 * sorted by name).
 */

export const PHOTO_REF_RE = /^[a-f0-9]{64}$/;

export function isValidPhotoRef(ref) {
  return PHOTO_REF_RE.test(String(ref || ""));
}

export function photoObjectKey(ref) {
  return `photos/${ref}.jpg`;
}

export function previewObjectKey(ref) {
  return `previews/${ref}.jpg`;
}

/**
 * R2 key for `/img/<albumId>/<kind>/<ref>`; null if kind or ref is invalid.
 * @param {"photos"|"preview"} kind
 */
export function imageObjectKey(kind, ref) {
  if (!isValidPhotoRef(ref)) return null;
  if (kind === "photos") return photoObjectKey(ref);
  if (kind === "preview") return previewObjectKey(ref);
  return null;
}

/** Non-negative integer byte size, or undefined if absent/invalid. */
export function normalizeFileSize(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Normalize one raw `files` entry; null if invalid. `size` is kept only when valid. */
export function normalizeFileEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  const ref = String(raw.ref || "").trim().toLowerCase();
  if (!isValidPhotoFileName(name) || !isValidPhotoRef(ref)) return null;
  const size = normalizeFileSize(raw.size);
  return size === undefined ? { name, ref } : { name, ref, size };
}

/**
 * Valid entries from `info.files`, de-duplicated by name (first wins), original order kept.
 * @returns {Array<{name: string, ref: string, size?: number}>}
 */
export function parseFileEntries(info) {
  const raw = info && Array.isArray(info.files) ? info.files : [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const e = normalizeFileEntry(r);
    if (!e || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

export function sortFileEntries(entries) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}
