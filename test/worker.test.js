import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { imageSig } from "../src/utils/crypto.js";

const ADMIN_TOKEN = "test-admin-token"; // see vitest.config.mjs
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const NOT_JPEG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function login() {
  const r = await SELF.fetch("https://x/api/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: ADMIN_TOKEN })
  });
  expect(r.status).toBe(200);
  return (await r.json()).sessionToken;
}

function admin(session) {
  return async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${session}`);
    return SELF.fetch(`https://x/api/admin${path}`, { ...init, headers });
  };
}

function jsonInit(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function uploadForm(name, photoBytes = JPEG, previewBytes = JPEG, overwrite = false) {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("overwrite", overwrite ? "1" : "0");
  fd.append("photo", new File([photoBytes], name, { type: "image/jpeg" }));
  fd.append("preview", new File([previewBytes], name, { type: "image/jpeg" }));
  return { method: "POST", body: fd };
}

describe("admin auth", () => {
  it("rejects wrong admin token and raw ADMIN_TOKEN as bearer", async () => {
    const bad = await SELF.fetch("https://x/api/admin/session", jsonInit("POST", { token: "wrong" }));
    expect(bad.status).toBe(401);

    const raw = await SELF.fetch("https://x/api/admin/albums", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(raw.status).toBe(401);

    const none = await SELF.fetch("https://x/api/admin/albums");
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("unknown admin routes need auth, then 404", async () => {
    expect((await SELF.fetch("https://x/api/admin/nope")).status).toBe(401);
    const api = admin(await login());
    expect((await api("/nope")).status).toBe(404);
  });
});

describe("album lifecycle", () => {
  let api;
  beforeEach(async () => {
    api = admin(await login());
  });

  it("create -> list -> update secrets -> gallery access -> signed image -> delete", async () => {
    const albumId = "2025.06.01-warm-summer-lake";

    const created = await api("/album", jsonInit("POST", { albumId, title: "Lake" }));
    expect(created.status).toBe(200);
    const { secret } = await created.json();
    expect(secret).toMatch(/^[0-9a-f]{6}$/);

    expect((await api("/album", jsonInit("POST", { albumId }))).status).toBe(409);
    expect((await api("/album", jsonInit("POST", { albumId: "bad/id" }))).status).toBe(400);

    const list = await (await api("/albums")).json();
    expect(list.albums).toEqual([{ albumId, title: "Lake", secretCount: 1, secrets: [secret] }]);

    // upload two photos, reject non-JPEG and duplicates
    expect((await api(`/album/${albumId}/file`, uploadForm("b.jpg"))).status).toBe(200);
    expect((await api(`/album/${albumId}/file`, uploadForm("a.jpg"))).status).toBe(200);
    expect((await api(`/album/${albumId}/file`, uploadForm("a.jpg"))).status).toBe(409);
    expect((await api(`/album/${albumId}/file`, uploadForm("a.jpg", JPEG, JPEG, true))).status).toBe(200);
    expect((await api(`/album/${albumId}/file`, uploadForm("c.jpg", NOT_JPEG))).status).toBe(400);
    expect((await api(`/album/${albumId}/file`, uploadForm("c.jpg", JPEG, NOT_JPEG))).status).toBe(400);

    const files = await (await api(`/album/${albumId}/files`)).json();
    expect(files.files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);

    // public gallery: wrong secret 403, right secret returns signed urls
    const forbidden = await SELF.fetch(`https://x/api/album/${albumId}`, jsonInit("POST", { secret: "nope" }));
    expect(forbidden.status).toBe(403);
    const missing = await SELF.fetch(`https://x/api/album/none`, jsonInit("POST", { secret }));
    expect(missing.status).toBe(404);

    const gallery = await SELF.fetch(`https://x/api/album/${albumId}`, jsonInit("POST", { secret }));
    expect(gallery.status).toBe(200);
    expect(gallery.headers.get("Cache-Control")).toBe("no-store");
    const g = await gallery.json();
    expect(g.title).toBe("Lake");
    expect(g.files.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);

    const sig = await imageSig(albumId, "a.jpg", secret);
    expect(g.files[0].photoUrl).toBe(`/img/${albumId}/photos/a.jpg?s=${sig}`);

    const img = await SELF.fetch(`https://x${g.files[0].previewUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);

    expect((await SELF.fetch(`https://x/img/${albumId}/photos/a.jpg`)).status).toBe(403);
    expect((await SELF.fetch(`https://x/img/${albumId}/photos/a.jpg?s=${"0".repeat(64)}`)).status).toBe(403);
    expect((await SELF.fetch(`https://x/img/${albumId}/photos/b.jpg?s=${sig}`)).status).toBe(403);

    // rotate secrets: old sig stops working, cache is invalidated
    const upd = await api(`/album/${albumId}`, jsonInit("PUT", { title: "Lake 2", secrets: ["newsecret"] }));
    expect(upd.status).toBe(200);
    expect((await SELF.fetch(`https://x${g.files[0].previewUrl}`)).status).toBe(403);
    const g2 = await (await SELF.fetch(`https://x/api/album/${albumId}`, jsonInit("POST", { secret: "newsecret" }))).json();
    expect(g2.title).toBe("Lake 2");
    const info = await (await env.BUCKET.get(`albums/${albumId}/info.json`)).json();
    expect(info.secrets).toEqual({ newsecret: {} });
    expect(info.secret).toBeUndefined();

    // rename / delete photo
    expect((await api(`/album/${albumId}/file/a.jpg`, jsonInit("PUT", { newName: "b.jpg" }))).status).toBe(409);
    expect((await api(`/album/${albumId}/file/a.jpg`, jsonInit("PUT", { newName: "z.jpg" }))).status).toBe(200);
    expect((await api(`/album/${albumId}/file/b.jpg`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/album/${albumId}/file/b.jpg`, { method: "DELETE" })).status).toBe(404);
    const after = await (await api(`/album/${albumId}/files`)).json();
    expect(after.files.map((f) => f.name)).toEqual(["z.jpg"]);
    expect(await env.BUCKET.head(`albums/${albumId}/photos/z.jpg`)).not.toBeNull();
    expect(await env.BUCKET.head(`albums/${albumId}/preview/z.jpg`)).not.toBeNull();
    expect(await env.BUCKET.head(`albums/${albumId}/photos/a.jpg`)).toBeNull();

    // delete album
    expect((await api(`/album/${albumId}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/album/${albumId}`, { method: "DELETE" })).status).toBe(404);
    expect((await env.BUCKET.list({ prefix: `albums/${albumId}/` })).objects).toHaveLength(0);
    expect((await SELF.fetch(`https://x/api/album/${albumId}`, jsonInit("POST", { secret: "newsecret" }))).status).toBe(404);
  });

  it("rebuild-files syncs info.json with the bucket", async () => {
    const albumId = "2025.06.02-quiet-forest-walk";
    await api("/album", jsonInit("POST", { albumId, secret: "abc" }));
    await env.BUCKET.put(`albums/${albumId}/photos/direct.jpg`, JPEG);
    await env.BUCKET.put(`albums/${albumId}/photos/ignored.png`, JPEG);

    const r = await (await api(`/album/${albumId}/rebuild-files`, { method: "POST" })).json();
    expect(r).toMatchObject({ ok: true, fileCount: 1, added: ["direct.jpg"], removed: [], missingPreviewCount: 1 });

    const all = await (await api("/albums/rebuild-files", { method: "POST" })).json();
    expect(all).toMatchObject({ albumCount: 1, albumsOk: 1, totalFiles: 1 });
  });

  it("renames an album in batches and can be resumed", async () => {
    // ALBUM_RENAME_BATCH=1 in vitest.config.mjs => one object per request
    const oldId = "2025.06.03-old-name-here";
    const newId = "2025.06.03-new-name-here";
    await api("/album", jsonInit("POST", { albumId: oldId, secret: "abc", title: "Old" }));
    await api(`/album/${oldId}/file`, uploadForm("1.jpg"));
    await api(`/album/${oldId}/file`, uploadForm("2.jpg"));
    // 4 objects to move (2 photos + 2 previews)

    const body = jsonInit("PUT", { title: "New", secrets: ["abc"], newAlbumId: newId });
    const step1 = await (await api(`/album/${oldId}`, body)).json();
    expect(step1).toMatchObject({ albumId: oldId, renameInProgress: true, moved: 1, remaining: 3 });
    // old info.json still there (resumable), new one not yet written
    expect(await env.BUCKET.head(`albums/${oldId}/info.json`)).not.toBeNull();
    expect(await env.BUCKET.head(`albums/${newId}/info.json`)).toBeNull();

    let last = step1;
    for (let i = 0; i < 10 && last.renameInProgress; i++) {
      last = await (await api(`/album/${oldId}`, body)).json();
    }
    expect(last).toEqual({ albumId: newId, title: "New", renamedFrom: oldId });

    expect(await env.BUCKET.head(`albums/${oldId}/info.json`)).toBeNull();
    expect((await env.BUCKET.list({ prefix: `albums/${oldId}/` })).objects).toHaveLength(0);
    const moved = (await env.BUCKET.list({ prefix: `albums/${newId}/` })).objects.map((o) => o.key).sort();
    expect(moved).toEqual([
      `albums/${newId}/info.json`,
      `albums/${newId}/photos/1.jpg`,
      `albums/${newId}/photos/2.jpg`,
      `albums/${newId}/preview/1.jpg`,
      `albums/${newId}/preview/2.jpg`
    ]);

    const g = await (await SELF.fetch(`https://x/api/album/${newId}`, jsonInit("POST", { secret: "abc" }))).json();
    expect(g.title).toBe("New");
    expect(g.files.map((f) => f.name)).toEqual(["1.jpg", "2.jpg"]);

    // destination taken
    await api("/album", jsonInit("POST", { albumId: oldId, secret: "abc" }));
    expect((await api(`/album/${oldId}`, jsonInit("PUT", { newAlbumId: newId }))).status).toBe(409);
  });
});

describe("routing", () => {
  it("404s unknown worker paths and non-matching methods", async () => {
    expect((await SELF.fetch("https://x/api/album/abc")).status).toBe(404); // GET not routed
    expect((await SELF.fetch("https://x/api/whatever")).status).toBe(404);
    expect((await SELF.fetch("https://x/img/a/other/x.jpg")).status).toBe(404);
  });

  it("rejects bad JSON on the album endpoint", async () => {
    const r = await SELF.fetch("https://x/api/album/abc", { method: "POST", body: "{" });
    expect(r.status).toBe(400);
  });
});
