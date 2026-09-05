/**
 * Gate for the gallery's client-side "download all as ZIP" feature.
 *
 * The archive is assembled in the visitor's browser from the signed original URLs (the
 * Worker never zips anything: Workers Free has 10 ms CPU and 50 subrequests per request).
 * The gate keeps the download within what a browser tab and the `/img` rate limit
 * (300/min) handle comfortably. The server decides, the client only displays the verdict.
 *
 * Env: ZIP_DOWNLOAD ("0" disables the feature), ZIP_MAX_FILES (default 100),
 *      ZIP_MAX_BYTES (default 500 MiB).
 */

export const ZIP_DEFAULT_MAX_FILES = 100;
export const ZIP_DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {Array<{name: string, ref: string, size?: number}>} entries parsed `files`
 * @returns {{ enabled: boolean, available: boolean, reason: string|null, fileCount: number,
 *             totalBytes: number, sizeKnown: boolean, maxFiles: number, maxBytes: number }}
 * `reason` is one of "disabled" | "empty" | "too_many_files" | "too_large" | "size_unknown" | null.
 */
export function zipPolicy(entries, env = {}) {
  const enabled = String(env.ZIP_DOWNLOAD ?? "1") !== "0";
  const maxFiles = positiveInt(env.ZIP_MAX_FILES, ZIP_DEFAULT_MAX_FILES);
  const maxBytes = positiveInt(env.ZIP_MAX_BYTES, ZIP_DEFAULT_MAX_BYTES);

  const fileCount = entries.length;
  let totalBytes = 0;
  let sizeKnown = true;
  for (const e of entries) {
    if (typeof e.size === "number") totalBytes += e.size;
    else sizeKnown = false;
  }

  let reason = null;
  if (!enabled) reason = "disabled";
  else if (fileCount === 0) reason = "empty";
  else if (fileCount > maxFiles) reason = "too_many_files";
  else if (totalBytes > maxBytes) reason = "too_large";
  else if (!sizeKnown) reason = "size_unknown";

  return { enabled, available: reason === null, reason, fileCount, totalBytes, sizeKnown, maxFiles, maxBytes };
}
