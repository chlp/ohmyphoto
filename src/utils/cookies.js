/**
 * Cookie helpers (minimal; no dependency on Node).
 */

export function getCookieValue(cookieHeader, name) {
  const raw = String(cookieHeader || "");
  if (!raw) return "";
  const parts = raw.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return p.slice(idx + 1).trim();
  }
  return "";
}

export function makeSetCookie({ name, value, maxAgeSec, secure }) {
  const attrs = [
    `${name}=${value}`,
    `Path=/`,
    `Max-Age=${Math.max(1, Math.floor(Number(maxAgeSec) || 0))}`,
    `HttpOnly`,
    `SameSite=Lax`
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}


