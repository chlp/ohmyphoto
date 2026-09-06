import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

async function callDO(ns, name, body) {
  const stub = ns.get(ns.idFromName(name));
  const r = await stub.fetch("https://do/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

describe("native rate limit bindings", () => {
  it("are configured (so the Durable Object fallback is not silently used)", async () => {
    for (const name of ["RL_ALBUM_API", "RL_ADMIN_API", "RL_IMG", "RL_OTHER"]) {
      expect(typeof env[name]?.limit, name).toBe("function");
    }
    expect((await env.RL_OTHER.limit({ key: "test-ip" })).success).toBe(true);
  });
});

describe("RateLimiterDO", () => {
  it("counts checks and blocks above the limit", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await callDO(env.RATE_LIMITER, key, { limit: 3, windowMs: 60_000 })).data);
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3].resetAtMs).toBeGreaterThan(Date.now());
  });

  it("rejects GET and invalid params", async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("x"));
    expect((await stub.fetch("https://do/")).status).toBe(405);
    expect((await callDO(env.RATE_LIMITER, "x", { limit: 0, windowMs: 10 })).status).toBe(400);
  });

  it("supports peek / adjust / reset", async () => {
    const key = `soft:${crypto.randomUUID()}`;
    expect((await callDO(env.RATE_LIMITER, key, { action: "peek" })).data).toMatchObject({ ok: true, count: 0 });

    await callDO(env.RATE_LIMITER, key, { action: "adjust", delta: 2, windowMs: 60_000 });
    const afterAdjust = (await callDO(env.RATE_LIMITER, key, { action: "peek" })).data;
    expect(afterAdjust.count).toBe(2);
    expect(afterAdjust.resetAtMs).toBeGreaterThan(Date.now());

    // never below zero
    await callDO(env.RATE_LIMITER, key, { action: "adjust", delta: -5 });
    expect((await callDO(env.RATE_LIMITER, key, { action: "peek" })).data.count).toBe(0);

    await callDO(env.RATE_LIMITER, key, { action: "adjust", delta: 1, windowMs: 60_000 });
    await callDO(env.RATE_LIMITER, key, { action: "reset" });
    expect((await callDO(env.RATE_LIMITER, key, { action: "peek" })).data.count).toBe(0);

    expect((await callDO(env.RATE_LIMITER, key, { action: "adjust", delta: "nan" })).status).toBe(400);
  });
});

describe("AlbumInfoDO", () => {
  // Unique id per test: the DO keeps an in-memory memo that outlives per-test storage isolation.
  let albumId;
  beforeEach(() => {
    albumId = `2025.01.01-test-${crypto.randomUUID().slice(0, 8)}`;
  });
  const get = () => callDO(env.ALBUM_INFO, `album:${albumId}`, { action: "get", albumId });
  const invalidate = () => callDO(env.ALBUM_INFO, `album:${albumId}`, { action: "invalidate" });

  it("caches info.json and extracted secrets until invalidated", async () => {
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify({ title: "T", secrets: { s1: {} }, files: [] }));

    const first = (await get()).data;
    expect(first).toMatchObject({ ok: true, cached: false, secrets: ["s1"] });
    expect(first.info.title).toBe("T");

    // change R2 behind the cache: DO must still serve the cached copy
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify({ title: "T2", secrets: { s2: {} }, files: [] }));
    const second = (await get()).data;
    expect(second).toMatchObject({ ok: true, cached: true, secrets: ["s1"] });

    await invalidate();
    const third = (await get()).data;
    expect(third).toMatchObject({ ok: true, cached: false, secrets: ["s2"] });
    expect(third.info.title).toBe("T2");
  });

  it("caches 404 and parse errors as negative results", async () => {
    const missing = (await get()).data;
    expect(missing).toMatchObject({ ok: false, status: 404 });
    expect((await get()).data.cached).toBe(true);

    await invalidate();
    await env.BUCKET.put(`albums/${albumId}/info.json`, "{not json");
    expect((await get()).data).toMatchObject({ ok: false, status: 500 });
  });

  it("validates albumId", async () => {
    const r = await callDO(env.ALBUM_INFO, "album:bad", { action: "get", albumId: "a/b" });
    expect(r.status).toBe(400);
  });

  it("counts views per secret, survives invalidate, merges and resets", async () => {
    const call = (body) => callDO(env.ALBUM_INFO, `album:${albumId}`, body);
    await env.BUCKET.put(`albums/${albumId}/info.json`, JSON.stringify({ title: "T", secrets: { s1: {}, s2: {} }, files: [] }));

    expect((await call({ action: "stats" })).data.stats).toEqual({ since: null, lastAt: null, total: 0, bySecret: {} });
    const withStats = (await call({ action: "get", albumId, withStats: true })).data;
    expect(withStats.stats).toEqual({ since: null, lastAt: null, total: 0, bySecret: {} });
    expect((await get()).data.stats).toBeUndefined();

    const t0 = Date.now();
    await call({ action: "hit", secret: "s1" });
    await call({ action: "hit", secret: "s1" });
    await call({ action: "hit", secret: "s2" });
    const st = (await call({ action: "stats" })).data.stats;
    expect(st.total).toBe(3);
    expect(st.bySecret).toEqual({ s1: 2, s2: 1 });
    expect(st.since).toBeGreaterThanOrEqual(t0);
    expect(st.lastAt).toBeGreaterThanOrEqual(st.since);

    // cache invalidation must not touch the counters
    await invalidate();
    expect((await call({ action: "stats" })).data.stats.total).toBe(3);
    expect((await get()).data.cached).toBe(false);

    // merge (rename) keeps the earliest start and sums per secret
    await call({ action: "importStats", stats: { since: t0 - 1000, lastAt: t0, total: 5, bySecret: { s2: 4, old: 1 } } });
    const merged = (await call({ action: "stats" })).data.stats;
    expect(merged).toMatchObject({ since: t0 - 1000, total: 8, bySecret: { s1: 2, s2: 5, old: 1 } });
    expect(merged.lastAt).toBe(st.lastAt);

    await call({ action: "resetStats" });
    expect((await call({ action: "stats" })).data.stats).toEqual({ since: null, lastAt: null, total: 0, bySecret: {} });
  });
});
