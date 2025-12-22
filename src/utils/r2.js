/**
 * Small R2 helpers (keep side-effect free; pass bucket explicitly).
 */

/**
 * List all keys under a prefix (best-effort; can be expensive for large prefixes).
 * @param {R2Bucket} bucket
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function listAllKeys(bucket, prefix) {
  const keys = [];
  let cursor = undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.cursor;
  } while (cursor);
  return keys;
}

/**
 * Copy an object within the same bucket (preserves metadata when available).
 * @param {R2Bucket} bucket
 * @param {string} fromKey
 * @param {string} toKey
 */
export async function copyObject(bucket, fromKey, toKey) {
  const obj = await bucket.get(fromKey);
  if (!obj) return;

  // Best-effort preserve metadata when available
  const opts = {};
  if (obj.httpMetadata) opts.httpMetadata = obj.httpMetadata;
  if (obj.customMetadata) opts.customMetadata = obj.customMetadata;

  await bucket.put(toKey, obj.body, opts);
}


