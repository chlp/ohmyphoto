/**
 * Extract secrets from album info.json: { secrets: { "<secret>": <any> } }.
 * Returns the secret strings (object keys, empty ones dropped).
 * Keep this logic shared between Worker and Durable Objects.
 */
export function extractSecrets(info) {
  if (!info || !info.secrets || typeof info.secrets !== 'object') return [];
  return Object.keys(info.secrets).filter(Boolean);
}
