import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { bytesToHex, imageSig } from "../src/utils/crypto.js";

const ADMIN_TOKEN = "test-admin-token"; // see vitest.config.mjs
// R2 storage is shared across the tests in this file and shared photos are keyed by content
// hash, so every test gets its own JPEG bytes (see beforeEach) to avoid cross-test collisions.
const jpegBytes = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, n & 0xff, (n >> 8) & 0xff, 0xff, 0xd9]);
let jpegSeq = 1;
let JPEG = jpegBytes(0);
let JPEG2 = jpegBytes(0);
const NOT_JPEG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function sha256(bytes) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

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

function uploadForm(name, photoBytes = JPEG, previewBytes = JPEG, { overwrite = false, ref = "" } = {}) {
  const fd = new FormData();
  fd.append("name", name);
  fd.append("overwrite", overwrite ? "1" : "0");
  if (ref) fd.append("ref", ref);
  fd.append("photo", new File([photoBytes], name, { type: "image/jpeg" }));
  fd.append("preview", new File([previewBytes], name, { type: "image/jpeg" }));
  return { method: "POST", body: fd };
}

// New secrets must be at least 16 chars (MIN_ALBUM_SECRET_LENGTH); these are test fixtures, not real ones.
const SA = "secret-a-0123456789";
const SB = "secret-b-0123456789";
const SC = "secret-c-0123456789";
const SK = "secret-k-0123456789";
const SD = "secret-d-0123456789";
const S_NEW = "rotated-secret-0123456789";

/** Drive the paginated verify-files endpoint until `done`. */
async function verifyAll(api, albumId) {
  let cursor = null;
  const acc = { fileCount: 0, invalid: 0, removed: [], missingPreviewCount: 0, sizeUpdated: 0, pages: 0, first: null };
  do {
    const resp = await api(`/album/${albumId}/verify-files`, jsonInit("POST", cursor ? { cursor } : {}));
    expect(resp.status).toBe(200);
    const r = await resp.json();
    if (!acc.first) acc.first = r;
    acc.fileCount = r.fileCount;
    acc.invalid += r.invalid;
    acc.removed.push(...r.removed);
    acc.missingPreviewCount += r.missingPreviewCount;
    acc.sizeUpdated += r.sizeUpdated;
    acc.pages += 1;
    cursor = r.done ? null : r.cursor;
  } while (cursor);
  return acc;
}

async function gallery(albumId, secret) {
  return SELF.fetch(`https://x/api/album/${albumId}`, jsonInit("POST", { secret }));
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
    JPEG = jpegBytes(jpegSeq++);
    JPEG2 = jpegBytes(jpegSeq++);
  });

  it("create -> upload -> gallery -> signed image -> rename/delete photo -> delete album", async () => {
    const albumId = "2025.06.01-warm-summer-lake";
    const refA = await sha256(JPEG);

    const created = await api("/album", jsonInit("POST", { albumId, title: "Lake" }));
    expect(created.status).toBe(200);
    const { secret } = await created.json();
    expect(secret).toMatch(/^[0-9a-f]{20}$/);

    expect((await api("/album", jsonInit("POST", { albumId }))).status).toBe(409);
    expect((await api("/album", jsonInit("POST", { albumId: "bad/id" }))).status).toBe(400);
    // new secrets must be long enough (the secret is also the HMAC key of every image URL)
    expect((await api("/album", jsonInit("POST", { albumId: "short-secret", secret: "abc123" }))).status).toBe(400);
    expect((await api("/album", jsonInit("POST", { albumId: "bad-secret", secret: "has space 0123456789" }))).status).toBe(400);

    const list = await (await api("/albums")).json();
    expect(list).toEqual({ albums: [{ albumId, title: "Lake", secretCount: 1, secrets: [secret], fileCount: 0, views: { since: null, lastAt: null, total: 0, bySecret: {} } }], cursor: null, done: true });

    // upload: ref is sha256 of the photo bytes when the client does not provide one
    const up1 = await api(`/album/${albumId}/file`, uploadForm("b.jpg", JPEG2));
    expect(up1.status).toBe(200);
    expect(await up1.json()).toMatchObject({ uploaded: true, name: "b.jpg", ref: await sha256(JPEG2), stored: true });
    const up2 = await api(`/album/${albumId}/file`, uploadForm("a.jpg"));
    expect(await up2.json()).toMatchObject({ name: "a.jpg", ref: refA, stored: true });
    expect(await env.BUCKET.head(`photos/${refA}.jpg`)).not.toBeNull();
    expect(await env.BUCKET.head(`previews/${refA}.jpg`)).not.toBeNull();
    expect((await env.BUCKET.list({ prefix: `albums/${albumId}/` })).objects.map((o) => o.key)).toEqual([`albums/${albumId}/info.json`]);

    // same name, different content -> 409; overwrite replaces
    expect((await api(`/album/${albumId}/file`, uploadForm("a.jpg", JPEG2))).status).toBe(409);
    expect((await api(`/album/${albumId}/file`, uploadForm("a.jpg", JPEG, JPEG, { overwrite: true }))).status).toBe(200);
    // same name, same content -> idempotent, nothing written
    expect(await (await api(`/album/${albumId}/file`, uploadForm("a.jpg"))).json()).toMatchObject({ stored: false, ref: refA });
    expect((await api(`/album/${albumId}/file`, uploadForm("c.jpg", NOT_JPEG))).status).toBe(400);
    expect((await api(`/album/${albumId}/file`, uploadForm("c.jpg", JPEG, NOT_JPEG))).status).toBe(400);
    expect((await api(`/album/${albumId}/file`, uploadForm("c.jpg", JPEG, JPEG, { ref: "zz" }))).status).toBe(400);

    const files = await (await api(`/album/${albumId}/files`)).json();
    expect(files.files.map((f) => [f.name, f.ref, f.size])).toEqual([["a.jpg", refA, JPEG.length], ["b.jpg", await sha256(JPEG2), JPEG2.length]]);
    expect(files.files[0].previewUrl).toBe(`/api/admin/album/${albumId}/raw/preview/${refA}`);
    expect((await api(files.files[0].previewUrl.replace("/api/admin", ""))).status).toBe(200);

    // public gallery: wrong secret 403, right secret returns signed urls keyed by ref
    expect((await gallery(albumId, "nope")).status).toBe(403);
    expect((await gallery("none", secret)).status).toBe(404);

    const g0 = await gallery(albumId, secret);
    expect(g0.status).toBe(200);
    expect(g0.headers.get("Cache-Control")).toBe("no-store");
    expect(g0.headers.get("X-OhMyPhoto-FileCount")).toBe("2");
    const g = await g0.json();
    expect(g.title).toBe("Lake");
    expect(g.files.map((f) => [f.name, f.size])).toEqual([["a.jpg", JPEG.length], ["b.jpg", JPEG2.length]]);
    // `ref` is exposed for photo deep links (`#<secret>/<ref>` opens the lightbox on that photo)
    expect(g.files.map((f) => f.ref)).toEqual([refA, await sha256(JPEG2)]);
    // client-side ZIP gate: two small files are well within the default limits
    expect(g.zip).toEqual({
      available: true, reason: null, fileCount: 2, totalBytes: JPEG.length + JPEG2.length,
      sizeKnown: true, maxFiles: 100, maxBytes: 500 * 1024 * 1024
    });

    const sig = await imageSig(albumId, refA, secret);
    expect(g.files[0].photoUrl).toBe(`/img/${albumId}/photos/${refA}?s=${sig}&n=a.jpg`);
    expect(g.files[0].previewUrl).toBe(`/img/${albumId}/preview/${refA}?s=${sig}`);

    // the display name only affects Content-Disposition; it is not signed and cannot change the object
    const orig = await SELF.fetch(`https://x${g.files[0].photoUrl}`);
    expect(orig.status).toBe(200);
    expect(orig.headers.get("Content-Disposition")).toBe('inline; filename="a.jpg"');
    expect((await SELF.fetch(`https://x/img/${albumId}/photos/${refA}?s=${sig}&n=..%2Fevil.jpg`)).headers.get("Content-Disposition")).toBeNull();

    const img = await SELF.fetch(`https://x${g.files[0].previewUrl}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/jpeg");
    expect(img.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable, s-maxage=86400");
    expect(img.headers.get("X-OhMyPhoto-Cache")).toBe("MISS");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);

    // second request for the same signed URL is served from the edge cache
    const img2 = await SELF.fetch(`https://x${g.files[0].previewUrl}`);
    expect(img2.headers.get("X-OhMyPhoto-Cache")).toBe("HIT");
    expect(new Uint8Array(await img2.arrayBuffer())).toEqual(JPEG);

    expect((await SELF.fetch(`https://x/img/${albumId}/photos/${refA}`)).status).toBe(403);
    expect((await SELF.fetch(`https://x/img/${albumId}/photos/${refA}?s=${"0".repeat(64)}`)).status).toBe(403);
    expect((await SELF.fetch(`https://x/img/${albumId}/photos/${await sha256(JPEG2)}?s=${sig}`)).status).toBe(403);
    expect((await SELF.fetch(`https://x/img/${albumId}/photos/not-a-ref?s=${sig}`)).status).toBe(403);

    // rotate secrets: old sig stops working, cache is invalidated; a new short secret is refused
    expect((await api(`/album/${albumId}`, jsonInit("PUT", { secrets: ["short"] }))).status).toBe(400);
    const upd = await api(`/album/${albumId}`, jsonInit("PUT", { title: "Lake 2", secrets: [S_NEW] }));
    expect(upd.status).toBe(200);
    // g.files[0].previewUrl is intentionally still served from the edge cache (documented trade-off);
    // an uncached URL signed with the old secret must be rejected.
    expect((await SELF.fetch(`https://x${g.files[1].previewUrl}`)).status).toBe(403);
    const g2 = await (await gallery(albumId, S_NEW)).json();
    expect(g2.title).toBe("Lake 2");
    const info = await (await env.BUCKET.get(`albums/${albumId}/info.json`)).json();
    expect(info.secrets).toEqual({ [S_NEW]: {} });
    expect(info.files).toEqual([{ name: "a.jpg", ref: refA, size: JPEG.length }, { name: "b.jpg", ref: await sha256(JPEG2), size: JPEG2.length }]);

    // rename / delete photo are metadata-only: shared objects untouched
    expect((await api(`/album/${albumId}/file/a.jpg`, jsonInit("PUT", { newName: "b.jpg" }))).status).toBe(409);
    expect((await api(`/album/${albumId}/file/a.jpg`, jsonInit("PUT", { newName: "z.jpg" }))).status).toBe(200);
    expect((await api(`/album/${albumId}/file/b.jpg`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/album/${albumId}/file/b.jpg`, { method: "DELETE" })).status).toBe(404);
    const after = await (await api(`/album/${albumId}/files`)).json();
    expect(after.files.map((f) => [f.name, f.ref, f.size])).toEqual([["z.jpg", refA, JPEG.length]]);
    expect(await env.BUCKET.head(`photos/${refA}.jpg`)).not.toBeNull();
    expect(await env.BUCKET.head(`photos/${await sha256(JPEG2)}.jpg`)).not.toBeNull();
    const gz = await (await gallery(albumId, S_NEW)).json();
    expect(gz.files[0].photoUrl).toContain(`/photos/${refA}?s=`);

    // delete album: info.json moves to trash/, shared photos stay for GC
    const del = await api(`/album/${albumId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const { trashKey } = await del.json();
    expect(trashKey).toMatch(new RegExp(`^trash/albums/${albumId}/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.json$`));
    expect((await api(`/album/${albumId}`, { method: "DELETE" })).status).toBe(404);
    expect((await env.BUCKET.list({ prefix: `albums/${albumId}/` })).objects).toHaveLength(0);
    expect(await env.BUCKET.head(`photos/${refA}.jpg`)).not.toBeNull();
    expect((await gallery(albumId, S_NEW)).status).toBe(404);

    // trash: listed, restorable, 409 if the album exists again, entries can be dropped
    const trash = await (await api("/trash")).json();
    expect(trash.items.find((t) => t.key === trashKey)).toMatchObject({ albumId, deletedAt: expect.stringMatching(/Z$/) });
    expect((await api("/trash/restore", jsonInit("POST", { key: "trash/albums/x/nope.json" }))).status).toBe(400);
    expect((await api("/trash/restore", jsonInit("POST", { key: trashKey, albumId: "bad/id" }))).status).toBe(400);
    const restored = await api("/trash/restore", jsonInit("POST", { key: trashKey }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ restored: true, albumId, key: trashKey });
    expect(await env.BUCKET.head(trashKey)).toBeNull();
    const gr = await (await gallery(albumId, S_NEW)).json();
    expect(gr.files.map((f) => f.name)).toEqual(["z.jpg"]);
    const del2 = await (await api(`/album/${albumId}`, { method: "DELETE" })).json();
    await api("/album", jsonInit("POST", { albumId, secret: SA }));
    expect((await api("/trash/restore", jsonInit("POST", { key: del2.trashKey }))).status).toBe(409);
    expect((await api(`/trash/${encodeURIComponent(del2.trashKey)}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/trash/${encodeURIComponent(del2.trashKey)}`, { method: "DELETE" })).status).toBe(404);
    expect(await env.BUCKET.head(del2.trashKey)).toBeNull();
    await api(`/album/${albumId}`, { method: "DELETE" });
  });

  it("counts album views per link, moves them on rename and resets", async () => {
    const api = admin(await login());
    const albumId = `2025.05.05-views-${crypto.randomUUID().slice(0, 8)}`;
    const renamed = `${albumId}-renamed`;
    await api("/album", jsonInit("POST", { albumId, secret: SA }));
    await api(`/album/${albumId}`, jsonInit("PUT", { secrets: [SA, SB] }));

    const fresh = await (await api(`/album/${albumId}/stats`)).json();
    expect(fresh).toEqual({ albumId, since: null, lastAt: null, total: 0, bySecret: {} });
    expect((await api(`/album/${albumId}-missing/stats`)).status).toBe(404);

    // Only successful opens count: wrong secret and unknown album do not move the counters.
    expect((await gallery(albumId, "wrong-secret-0123456789")).status).toBe(403);
    expect((await gallery(`${albumId}-missing`, SA)).status).toBe(404);
    expect((await gallery(albumId, SA)).status).toBe(200);
    expect((await gallery(albumId, SA)).status).toBe(200);
    expect((await gallery(albumId, SB)).status).toBe(200);

    // The hit is recorded in ctx.waitUntil; give it a moment.
    const waitForTotal = async (id, total) => {
      for (let i = 0; i < 20; i++) {
        const st = await (await api(`/album/${id}/stats`)).json();
        if (st.total === total) return st;
        await new Promise((r) => setTimeout(r, 25));
      }
      return (await api(`/album/${id}/stats`)).json();
    };
    const st = await waitForTotal(albumId, 3);
    expect(st.total).toBe(3);
    expect(st.bySecret).toEqual({ [SA]: 2, [SB]: 1 });
    expect(st.since).toBeGreaterThan(0);
    expect(st.lastAt).toBeGreaterThanOrEqual(st.since);

    // the list carries the summary from the same DO round-trip
    let listed = null;
    for (let cursor = null, done = false; !done;) {
      const page = await (await api(`/albums${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
      listed = listed || page.albums.find((a) => a.albumId === albumId);
      cursor = page.cursor;
      done = page.done;
    }
    expect(listed.views).toEqual({ since: st.since, lastAt: st.lastAt, total: 3, bySecret: { [SA]: 2, [SB]: 1 } });

    // rename moves the counters to the new id
    expect((await api(`/album/${albumId}`, jsonInit("PUT", { newAlbumId: renamed }))).status).toBe(200);
    const moved = await (await api(`/album/${renamed}/stats`)).json();
    expect(moved).toMatchObject({ total: 3, since: st.since, bySecret: { [SA]: 2, [SB]: 1 } });
    // the old id is gone (404 for stats), and a re-created album under it starts from zero
    expect((await api(`/album/${albumId}/stats`)).status).toBe(404);
    await api("/album", jsonInit("POST", { albumId, secret: SC }));
    expect((await (await api(`/album/${albumId}/stats`)).json()).total).toBe(0);

    // reset
    expect((await api(`/album/${renamed}/stats`, { method: "DELETE" })).status).toBe(200);
    expect(await (await api(`/album/${renamed}/stats`)).json()).toEqual({ albumId: renamed, since: null, lastAt: null, total: 0, bySecret: {} });
  });

  it("de-duplicates uploads and attaches existing photos to another album", async () => {
    const a = "2025.06.05-full-shoot-all";
    const b = "2025.06.05-client-favourites";
    const ref = await sha256(JPEG);
    await api("/album", jsonInit("POST", { albumId: a, secret: SA }));
    await api("/album", jsonInit("POST", { albumId: b, secret: SB }));

    expect(await (await api(`/photo/${ref}`)).json()).toEqual({ ref, exists: false, hasPreview: false });
    expect((await api(`/photo/nope`)).status).toBe(400);

    // client-provided ref (hash of the source file) is used as the storage key
    const up = await api(`/album/${a}/file`, uploadForm("001.jpg", JPEG, JPEG2, { ref }));
    expect(await up.json()).toMatchObject({ ref, stored: true });
    expect(new Uint8Array(await (await env.BUCKET.get(`previews/${ref}.jpg`)).arrayBuffer())).toEqual(JPEG2);
    // same bytes under a different name in the same album: no new object
    expect(await (await api(`/album/${a}/file`, uploadForm("002.jpg", JPEG))).json()).toMatchObject({ ref, stored: false });
    expect(await (await api(`/photo/${ref}`)).json()).toEqual({ ref, exists: true, hasPreview: true });

    // attach to album b without uploading anything
    const att = await api(`/album/${b}/files`, jsonInit("POST", { files: [{ name: "fav-1.jpg", ref }] }));
    expect(att.status).toBe(200);
    expect(await att.json()).toMatchObject({ attached: 1, albumId: b });
    expect((await api(`/album/${b}/files`, jsonInit("POST", { files: [{ name: "fav-1.jpg", ref: await sha256(JPEG2) }] }))).status).toBe(400);
    expect((await api(`/album/${b}/files`, jsonInit("POST", { files: [{ name: "bad", ref: "x" }] }))).status).toBe(400);
    expect((await api(`/album/${b}/files`, jsonInit("POST", { files: [] }))).status).toBe(200);
    // attach is paginated to stay within the subrequest budget; the admin UI sends chunks
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ name: `m${i}.jpg`, ref }));
    expect((await api(`/album/${b}/files`, jsonInit("POST", { files: tooMany }))).status).toBe(400);

    const gb = await (await gallery(b, SB)).json();
    expect(gb.files.map((f) => [f.name, f.size])).toEqual([["fav-1.jpg", JPEG.length]]);
    expect(gb.files[0].photoUrl).toBe(`/img/${b}/photos/${ref}?s=${await imageSig(b, ref, SB)}&n=fav-1.jpg`);
    expect((await SELF.fetch(`https://x${gb.files[0].photoUrl}`)).status).toBe(200);
    // a signature from album a does not open the same object through album b
    expect((await SELF.fetch(`https://x/img/${b}/photos/${ref}?s=${await imageSig(a, ref, SA)}`)).status).toBe(403);

    // name conflict with a different ref -> 409 unless overwrite
    await api(`/album/${b}/file`, uploadForm("fav-2.jpg", JPEG2));
    const clash = await api(`/album/${b}/files`, jsonInit("POST", { files: [{ name: "fav-2.jpg", ref }] }));
    expect(clash.status).toBe(409);
    expect((await api(`/album/${b}/files`, jsonInit("POST", { files: [{ name: "fav-2.jpg", ref }], overwrite: true }))).status).toBe(200);
    const fb = await (await api(`/album/${b}/files`)).json();
    expect(fb.files.map((f) => f.ref)).toEqual([ref, ref]);
  });

  it("renames an album by moving info.json only", async () => {
    const oldId = "2025.06.03-old-name-here";
    const newId = "2025.06.03-new-name-here";
    await api("/album", jsonInit("POST", { albumId: oldId, secret: SC, title: "Old" }));
    await api(`/album/${oldId}/file`, uploadForm("1.jpg"));
    const ref = await sha256(JPEG);

    const r = await api(`/album/${oldId}`, jsonInit("PUT", { title: "New", secrets: [SC], newAlbumId: newId }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ albumId: newId, title: "New", renamedFrom: oldId });
    expect(await env.BUCKET.head(`albums/${oldId}/info.json`)).toBeNull();
    expect((await env.BUCKET.list({ prefix: `albums/${newId}/` })).objects.map((o) => o.key)).toEqual([`albums/${newId}/info.json`]);
    expect((await gallery(oldId, SC)).status).toBe(404);

    const g = await (await gallery(newId, SC)).json();
    expect(g.title).toBe("New");
    expect(g.files[0].photoUrl).toBe(`/img/${newId}/photos/${ref}?s=${await imageSig(newId, ref, SC)}&n=1.jpg`);
    expect((await SELF.fetch(`https://x${g.files[0].photoUrl}`)).status).toBe(200);

    // destination taken
    await api("/album", jsonInit("POST", { albumId: oldId, secret: SC }));
    expect((await api(`/album/${oldId}`, jsonInit("PUT", { newAlbumId: newId }))).status).toBe(409);
    expect((await api(`/album/nope`, jsonInit("PUT", { title: "x" }))).status).toBe(404);
  });

  it("verify-files drops entries whose object is gone and counts missing previews", async () => {
    const albumId = "2025.06.02-quiet-forest-walk";
    await api("/album", jsonInit("POST", { albumId, secret: SC }));
    await api(`/album/${albumId}/file`, uploadForm("kept.jpg"));
    const gone = await sha256(JPEG2);
    await api(`/album/${albumId}/file`, uploadForm("gone.jpg", JPEG2));
    await env.BUCKET.delete([`photos/${gone}.jpg`, `previews/${await sha256(JPEG)}.jpg`]);

    // strip the recorded size of kept.jpg: verify must backfill it from the object
    const infoKey = `albums/${albumId}/info.json`;
    const before = await (await env.BUCKET.get(infoKey)).json();
    before.files = before.files.map(({ name, ref }) => ({ name, ref }));
    await env.BUCKET.put(infoKey, JSON.stringify(before));

    const r = await (await api(`/album/${albumId}/verify-files`, { method: "POST" })).json();
    expect(r).toEqual({ ok: true, albumId, fileCount: 1, checked: 2, invalid: 0, removed: ["gone.jpg"], missingPreviewCount: 1, sizeUpdated: 1, cursor: null, done: true });
    const info = await (await env.BUCKET.get(infoKey)).json();
    expect(info.files).toEqual([{ name: "kept.jpg", ref: await sha256(JPEG), size: JPEG.length }]);
    expect((await api(`/album/nope/verify-files`, { method: "POST" })).status).toBe(404);
    expect(await verifyAll(api, albumId)).toMatchObject({ fileCount: 1, removed: [], pages: 1 });
  });

  it("verify-files walks large albums page by page (subrequest budget)", async () => {
    const albumId = "2025.06.02-big-album-pages";
    await api("/album", jsonInit("POST", { albumId, secret: SC }));
    const infoKey = `albums/${albumId}/info.json`;
    await api(`/album/${albumId}/file`, uploadForm("p0.jpg"));
    const info = await (await env.BUCKET.get(infoKey)).json();
    // 45 entries: 44 point at one real object (sizes stripped), one at a missing object
    const ref = await sha256(JPEG);
    const gone = await sha256(JPEG2);
    info.files = [
      ...Array.from({ length: 44 }, (_, i) => ({ name: `p${i}.jpg`, ref })),
      { name: "missing.jpg", ref: gone }
    ];
    await env.BUCKET.put(infoKey, JSON.stringify(info));
    await api(`/album/${albumId}`, jsonInit("PUT", { title: "bust cache" }));

    const acc = await verifyAll(api, albumId);
    // "missing.jpg" sorts into page 1, so the first page already drops it
    expect(acc.first).toMatchObject({ done: false, checked: 20, fileCount: 44, removed: ["missing.jpg"] });
    expect(typeof acc.first.cursor).toBe("string");
    expect(acc).toMatchObject({ fileCount: 44, removed: ["missing.jpg"], invalid: 0, pages: 3 });
    expect(acc.sizeUpdated).toBe(44);
    const after = await (await env.BUCKET.get(infoKey)).json();
    expect(after.files).toHaveLength(44);
    expect(after.files.every((f) => f.size === JPEG.length)).toBe(true);
    // natural order: p2 before p10
    expect(after.files.map((f) => f.name).slice(0, 12)).toEqual(["p0.jpg", "p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg", "p5.jpg", "p6.jpg", "p7.jpg", "p8.jpg", "p9.jpg", "p10.jpg", "p11.jpg"]);
  });

  it("verify-files drops legacy/invalid entries and the album list counts only valid ones", async () => {
    const albumId = "2025.06.04-legacy-string-files";
    await api("/album", jsonInit("POST", { albumId, secret: SC }));
    await api(`/album/${albumId}/file`, uploadForm("real.jpg"));
    const infoKey = `albums/${albumId}/info.json`;
    const info = await (await env.BUCKET.get(infoKey)).json();
    // pre content-addressed layout: files were bare names; also a ref-less object and a duplicate
    info.files = ["old1.jpg", "old2.jpg", { name: "noref.jpg" }, ...info.files, ...info.files];
    await env.BUCKET.put(infoKey, JSON.stringify(info));
    await api(`/album/${albumId}`, jsonInit("PUT", { title: "bust cache" }));

    const list = await (await api("/albums")).json();
    expect(list.albums.find((a) => a.albumId === albumId).fileCount).toBe(1);

    const r = await (await api(`/album/${albumId}/verify-files`, { method: "POST" })).json();
    expect(r).toMatchObject({ ok: true, fileCount: 1, invalid: 4, removed: [], sizeUpdated: 0 });
    const after = await (await env.BUCKET.get(infoKey)).json();
    expect(after.files).toEqual([{ name: "real.jpg", ref: await sha256(JPEG), size: JPEG.length }]);

    const again = await (await api(`/album/${albumId}/verify-files`, { method: "POST" })).json();
    expect(again).toMatchObject({ invalid: 0, removed: [], sizeUpdated: 0, done: true });
  });

  it("gallery reports the ZIP download as unavailable while sizes are unknown", async () => {
    const albumId = "2025.06.03-legacy-no-sizes";
    await api("/album", jsonInit("POST", { albumId, secret: SC }));
    await api(`/album/${albumId}/file`, uploadForm("x.jpg"));
    const infoKey = `albums/${albumId}/info.json`;
    const info = await (await env.BUCKET.get(infoKey)).json();
    info.files = info.files.map(({ name, ref }) => ({ name, ref }));
    await env.BUCKET.put(infoKey, JSON.stringify(info));
    await api(`/album/${albumId}`, jsonInit("PUT", { title: "bust cache" }));

    const g = await (await gallery(albumId, SC)).json();
    expect(g.files[0].size).toBeUndefined();
    expect(g.zip).toMatchObject({ available: false, reason: "size_unknown", fileCount: 1, sizeKnown: false });

    await api(`/album/${albumId}/verify-files`, { method: "POST" });
    const g2 = await (await gallery(albumId, SC)).json();
    expect(g2.zip).toMatchObject({ available: true, reason: null, totalBytes: JPEG.length });
  });

  it("gc deletes shared objects no album references (dry run first)", async () => {
    const keep = "2025.06.07-keep-me";
    const drop = "2025.06.07-drop-me";
    await api("/album", jsonInit("POST", { albumId: keep, secret: SK }));
    await api("/album", jsonInit("POST", { albumId: drop, secret: SD }));
    await api(`/album/${keep}/file`, uploadForm("k.jpg", JPEG));
    await api(`/album/${drop}/file`, uploadForm("d.jpg", JPEG2));
    await env.BUCKET.put("photos/junk.txt", "x");
    const kept = await sha256(JPEG);
    const orphan = await sha256(JPEG2);
    expect((await api(`/album/${drop}`, { method: "DELETE" })).status).toBe(200);

    // a run starts by collecting referenced refs from the albums (paged), then scans both prefixes;
    // default is dry run (other tests leave orphans too, so check keys, not counts)
    let r = await (await api("/photos/gc", jsonInit("POST", {}))).json();
    expect(r).toMatchObject({ dryRun: true, phase: "refs", done: false, scanned: 0, deleted: 0 });
    expect(r.albumCount).toBeGreaterThanOrEqual(1);
    expect(r.referencedRefs).toBeGreaterThanOrEqual(1);
    expect(await env.BUCKET.head(`gc/${r.runId}.json`)).not.toBeNull();
    while (r.phase === "refs") r = await (await api("/photos/gc", jsonInit("POST", { cursor: r.cursor }))).json();
    expect(r).toMatchObject({ dryRun: true, phase: "scan", done: false, prefix: "photos/", deleted: 0 });
    expect(r.orphanCount).toBeGreaterThanOrEqual(2);
    expect(r.orphans).toEqual(expect.arrayContaining([`photos/${orphan}.jpg`, "photos/junk.txt"]));
    expect(r.orphans).not.toContain(`photos/${kept}.jpg`);
    const runId = r.runId;
    r = await (await api("/photos/gc", jsonInit("POST", { cursor: r.cursor }))).json();
    expect(r).toMatchObject({ dryRun: true, done: true, prefix: "previews/" });
    expect(r.orphans).toContain(`previews/${orphan}.jpg`);
    expect(r.orphans).not.toContain(`previews/${kept}.jpg`);
    expect(await env.BUCKET.head(`photos/${orphan}.jpg`)).not.toBeNull();
    // the run's snapshot is gone once it finished; stale or garbage cursors are rejected
    expect(await env.BUCKET.head(`gc/${runId}.json`)).toBeNull();
    expect((await api("/photos/gc", jsonInit("POST", { cursor: `scan|${runId}|photos/|` }))).status).toBe(400);
    expect((await api("/photos/gc", jsonInit("POST", { cursor: "garbage" }))).status).toBe(400);

    let cursor;
    do {
      r = await (await api("/photos/gc", jsonInit("POST", { dryRun: false, cursor }))).json();
      expect(r.deleted).toBe(r.orphanCount);
      cursor = r.cursor;
    } while (!r.done);
    expect(await env.BUCKET.head(`gc/${r.runId}.json`)).toBeNull();
    expect(await env.BUCKET.head(`photos/${orphan}.jpg`)).toBeNull();
    expect(await env.BUCKET.head(`previews/${orphan}.jpg`)).toBeNull();
    expect(await env.BUCKET.head("photos/junk.txt")).toBeNull();
    expect(await env.BUCKET.head(`photos/${kept}.jpg`)).not.toBeNull();
    expect(await env.BUCKET.head(`previews/${kept}.jpg`)).not.toBeNull();
    expect((await SELF.fetch(`https://x${(await (await gallery(keep, SK)).json()).files[0].photoUrl}`)).status).toBe(200);
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
