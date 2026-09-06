import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleAlbumRequest } from "../src/api/album.js";

// The e2e config blanks TURNSTILE_SECRET_KEY, so the soft-enforcement branch is exercised here by
// calling the handler directly with an env override. Nothing reaches Cloudflare's siteverify:
// no request in this file carries a Turnstile token.
const SECRET = "soft-secret-0123456789";

function softEnv(overrides = {}) {
  return {
    ...env,
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    TURNSTILE_SOFT_THRESHOLD: "2",
    // Generous DO timeouts so the counter is never skipped (fail-open) on a slow test runner.
    TURNSTILE_SOFT_DO_TIMEOUT_MS: "5000",
    ...overrides
  };
}

function ctxFor(promises) {
  return { waitUntil: (p) => promises.push(p) };
}

async function seedAlbum(albumId) {
  await env.BUCKET.put(
    `albums/${albumId}/info.json`,
    JSON.stringify({ title: "Soft", secrets: { [SECRET]: {} }, files: [] })
  );
}

async function call(albumId, { secret, ip, cookie = "", envOverrides } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (cookie) headers.Cookie = cookie;
  const req = new Request(`https://x/api/album/${albumId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ secret, turnstileToken: "" })
  });
  const pending = [];
  const resp = await handleAlbumRequest(req, softEnv(envOverrides), albumId, ctxFor(pending));
  await Promise.all(pending);
  return resp;
}

async function softCount(ip) {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`turnstile_soft:${ip}`));
  const r = await stub.fetch("https://rate-limiter/turnstile-soft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "peek" })
  });
  return (await r.json()).count;
}

function cookieFrom(resp) {
  const sc = resp.headers.get("Set-Cookie") || "";
  return sc.split(";")[0];
}

describe("soft Turnstile counter", () => {
  it("does not count a valid secret and hands out the bypass cookie", async () => {
    const albumId = "soft-valid-" + crypto.randomUUID();
    const ip = "10.0.0.1";
    await seedAlbum(albumId);

    for (let i = 0; i < 5; i++) {
      const r = await call(albumId, { secret: SECRET, ip });
      expect(r.status).toBe(200);
      expect(r.headers.get("Set-Cookie") || "").toMatch(/^ohmyphoto_human=/);
    }
    expect(await softCount(ip)).toBe(0);
  });

  it("counts wrong secrets and unknown albums, then enforces the challenge", async () => {
    const albumId = "soft-bad-" + crypto.randomUUID();
    const ip = "10.0.0.2";
    await seedAlbum(albumId);

    const wrong = await call(albumId, { secret: "wrong-secret-0123456789", ip });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toBe("Invalid secret");
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    expect(await softCount(ip)).toBe(1);

    const missing = await call("no-such-album-" + crypto.randomUUID(), { secret: SECRET, ip });
    expect(missing.status).toBe(404);
    expect(await softCount(ip)).toBe(2);

    // Threshold reached: even the correct secret now needs Turnstile (or the cookie).
    const blocked = await call(albumId, { secret: SECRET, ip });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toBe("Bot verification required");
    // Enforced requests are not counted again.
    expect(await softCount(ip)).toBe(2);
  });

  it("accepts the bypass cookie earned by a valid visit once the IP is enforced", async () => {
    const albumId = "soft-cookie-" + crypto.randomUUID();
    const ip = "10.0.0.3";
    await seedAlbum(albumId);

    const first = await call(albumId, { secret: SECRET, ip });
    expect(first.status).toBe(200);
    const cookie = cookieFrom(first);
    expect(cookie).toMatch(/^ohmyphoto_human=.+/);

    for (let i = 0; i < 2; i++) {
      expect((await call(albumId, { secret: "wrong-secret-0123456789", ip })).status).toBe(403);
    }
    expect((await call(albumId, { secret: SECRET, ip })).status).toBe(403);

    const withCookie = await call(albumId, { secret: SECRET, ip, cookie });
    expect(withCookie.status).toBe(200);
    // Sliding TTL: the cookie is refreshed.
    expect(withCookie.headers.get("Set-Cookie") || "").toMatch(/^ohmyphoto_human=/);

    // The cookie is bound to the IP.
    const otherIp = await call(albumId, { secret: SECRET, ip: "10.0.0.4", cookie });
    expect(otherIp.status).toBe(200); // other IP is under its own threshold...
    expect(await softCount("10.0.0.4")).toBe(0); // ...and a valid secret still costs nothing
  });

  it("does not count a broken info.json", async () => {
    const albumId = "soft-broken-" + crypto.randomUUID();
    const ip = "10.0.0.5";
    await env.BUCKET.put(`albums/${albumId}/info.json`, "{not json");
    const r = await call(albumId, { secret: SECRET, ip });
    expect(r.status).toBe(500);
    expect(await softCount(ip)).toBe(0);
  });
});
