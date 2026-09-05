import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getInfoJsonWithEtag, infoKey, listAlbumIds, putInfoJson, updateInfoJson } from "../src/api/admin/infoStore.js";

describe("updateInfoJson (ETag-conditional read-modify-write)", () => {
  it("writes when nothing changed underneath", async () => {
    const id = "etag-plain-album";
    await putInfoJson(env, id, { title: "a", secrets: {}, files: [] });
    const r = await updateInfoJson(env, id, (info) => ({ info: { ...info, title: "b" }, result: 42 }));
    expect(r).toEqual({ ok: true, result: 42 });
    expect((await getInfoJsonWithEtag(env, id)).info.title).toBe("b");
  });

  it("retries with fresh data when the object changed between read and write", async () => {
    const id = "etag-racy-album";
    await putInfoJson(env, id, { title: "a", secrets: {}, files: [], n: 0 });
    let calls = 0;
    const r = await updateInfoJson(env, id, async (info) => {
      calls += 1;
      if (calls === 1) {
        // another writer lands in between: our first attempt must not clobber it
        await env.BUCKET.put(infoKey(id), JSON.stringify({ ...info, n: 100, other: true }));
      }
      return { info: { ...info, n: info.n + 1 } };
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect((await getInfoJsonWithEtag(env, id)).info).toMatchObject({ n: 101, other: true });
  });

  it("gives up with 409 after the configured attempts", async () => {
    const id = "etag-hostile-album";
    await putInfoJson(env, id, { title: "a", secrets: {}, files: [] });
    const r = await updateInfoJson(env, id, async (info) => {
      await env.BUCKET.put(infoKey(id), JSON.stringify({ ...info, bump: Math.random() }));
      return { info: { ...info, mine: true } };
    }, { attempts: 2 });
    expect(r.ok).toBe(false);
    expect(r.response.status).toBe(409);
    expect((await getInfoJsonWithEtag(env, id)).info.mine).toBeUndefined();
  });

  it("aborts without writing when fn returns a response, and 404s a missing album", async () => {
    const id = "etag-abort-album";
    await putInfoJson(env, id, { title: "a", secrets: {}, files: [] });
    const r = await updateInfoJson(env, id, () => ({ response: new Response("no", { status: 400 }) }));
    expect(r.ok).toBe(false);
    expect(r.response.status).toBe(400);
    expect((await getInfoJsonWithEtag(env, id)).info.title).toBe("a");
    const missing = await updateInfoJson(env, "etag-no-such-album", () => ({ info: {} }));
    expect(missing.ok).toBe(false);
    expect(missing.response.status).toBe(404);
  });
});

describe("listAlbumIds", () => {
  it("pages through albums/ with a cursor", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `page-test-${i}`);
    for (const id of ids) await putInfoJson(env, id, { title: id, secrets: {}, files: [] });
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = await listAlbumIds(env, { cursor, limit: 3 });
      seen.push(...page.ids);
      cursor = page.cursor || undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(ids.every((id) => seen.includes(id))).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
