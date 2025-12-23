/**
 * Extract secrets from album info.json.
 * Supports:
 * - { secret: "..." }
 * - { secrets: { "<secret>": <any> } }
 *
 * Returns a de-duplicated array of secrets (strings).
 * Keep this logic shared between Worker and Durable Objects.
 */
export function extractSecrets(info) {
  const secrets = new Set();
  if (info && typeof info.secret === 'string' && info.secret) secrets.add(info.secret);
  if (info && info.secrets && typeof info.secrets === 'object') {
    for (const k of Object.keys(info.secrets)) {
      if (k) secrets.add(k);
    }
  }
  return [...secrets];
}


