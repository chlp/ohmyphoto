# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

```bash
# Local dev server (Cloudflare Workers via Wrangler)
npx wrangler dev

# Build static assets (templates → public/index.html, public/admin.html)
node scripts/build-assets.mjs

# Copy a local bucket mirror (./r2/**) into local R2 (local dev only)
bash cp_albums_local.sh

# Tests (vitest + @cloudflare/vitest-pool-workers, runs inside workerd)
npm test
npm run test:watch
```

`npm install` first. No lint config. Related docs: `README.md` (feature overview), `USAGE.md` (Russian end-user guide for the admin UI), `IDEAS.md` (backlog of ideas and future features, in Russian; add new wishes there, move finished ones to "Сделано").

**Tests** live in `test/*.test.js`; config in `vitest.config.mjs`. CI runs them on every push/PR (`.github/workflows/test.yml`). They run against the real `wrangler.toml` bindings with local R2/DO/rate-limit simulators, `remoteBindings: false` (Workers AI is never called), `TURNSTILE_SECRET_KEY` blanked, `RATE_LIMIT_DISABLED=1` (the e2e suite exceeds the 60/min admin limit; limiter logic is covered in `durable.test.js`) and `PHOTO_GC_GRACE_MS=0`. `test/worker.test.js` drives the full Worker via `SELF.fetch()`; add an end-to-end case there for any new admin route. R2 state is shared between tests in a file and shared photos are keyed by content hash, so each test gets unique JPEG bytes (`beforeEach`) and unique album IDs. `test/zip.test.js` imports the client ZIP writer (`public/zip.js`) directly; `test/infoStore.test.js` covers the ETag-conditional `info.json` update.

Note: `wrangler dev` without a TTY fails on the remote AI binding; use `npx wrangler dev --local` for scripted smoke tests (AI then returns "AI generation failed", everything else works). `public/_headers` changes need a dev-server restart.

## Architecture

**Runtime**: Cloudflare Workers (no Node.js). All code must use Workers-compatible APIs (`crypto.subtle`, `fetch`, `Response`, `URL`, etc.). Plain ES modules, no bundler.

**Entry point**: `src/worker.js` — applies per-IP rate limiting (`src/utils/rateLimit.js`) then delegates to `src/router.js`. Also re-exports both Durable Object classes.

**Routing** (`src/router.js`):
- `/api/admin/*` → `src/api/admin/index.js` (checked first)
- `POST /api/album/<albumId>` → `src/api/album.js`
- `GET /img/<albumId>/(photos|preview)/<name>` → `src/api/image.js`
- Anything else → 404 from the Worker. Static assets are served by the Assets binding *before* the Worker for all paths except `/api/*` and `/img/*` (`run_worker_first` in `wrangler.toml`), with SPA fallback so `/<albumId>` serves `index.html`.

**Cloudflare bindings** (`wrangler.toml`):
| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 (`ohmyphoto`) | Album data storage |
| `RATE_LIMITER` | Durable Object `RateLimiterDO` | Admin-login rate limit (10-min window) + Turnstile soft counters; fallback for the native limiters |
| `RL_ALBUM_API`, `RL_ADMIN_API`, `RL_IMG`, `RL_OTHER` | Rate Limiting (`[[ratelimits]]`) | Native per-IP limiters, 60s window, no DO round-trip |
| `ALBUM_INFO` | Durable Object `AlbumInfoDO` | Persistent cache for `info.json` per album + view counters |
| `AI` | Workers AI | Album ID / title generation |
| `ASSETS` | Static | Serves `public/` |

DO migrations: `v1` RateLimiterDO, `v2` AlbumIndexDO (added), `v3` AlbumInfoDO, `v4` AlbumIndexDO deleted. Do not reuse the class name `AlbumIndexDO`.

**R2 data layout** (content-addressed, photos shared between albums):
```
photos/<ref>.jpg                 # original (JPEG), ref = sha256 hex (64 chars) of the source file
previews/<ref>.jpg               # preview (JPEG), same ref
albums/<albumId>/info.json       # { title, secrets, files: [ { name, ref, size? }, ... ] }
trash/albums/<albumId>/<ts>.json # info.json of a deleted album (restorable from the admin UI)
gc/<runId>.json                  # transient snapshot of referenced refs during a GC run
```

- An album is **only its `info.json`**. `files` is the authoritative photo list: the public album endpoint never lists R2; if `files` is missing it returns 500. Each entry is `{ name, ref, size? }`; `name` is the display name, unique within an album; `ref` is the storage identity and may appear in many albums; `size` is the byte size of the original, recorded on upload/attach and backfilled by verify-files (used only by the ZIP gate below). Anything else in `files` is ignored. Parsing lives in `src/utils/albumFiles.js` (`parseFileEntries`, `imageObjectKey`, `compareNames`). The gallery renders entries in array order; admin writes keep `files` sorted in natural order (`compareNames`: `2.jpg` before `10.jpg`, so numeric prefixes need no zero padding) and de-duplicated by name.
- A photo's `ref` is computed by the admin UI as SHA-256 of the **original source file** (before canvas conversion), so re-uploading the same photo from any device or into any album de-duplicates. If the upload omits `ref`, the server hashes the uploaded JPEG bytes instead.
- Renaming an album or a photo, deleting a photo from an album and composing a new album from existing photos only rewrite `info.json`; objects are never copied or moved.
- **Listing rule**: nothing on the public path (`/api/album`, `/img`) ever lists R2; existence checks use `head()` on `photos/<ref>.jpg`. Listing happens only in the admin album list (delimiter listing of `albums/`, one page per request), in GC (one 1000-key page per request) and in the trash list.
- **Concurrency**: every admin read-modify-write of `info.json` goes through `updateInfoJson()` (`src/api/admin/infoStore.js`): read with ETag, mutate, `put` with `onlyIf: { etagMatches }`, retry up to 3 times, else 409. Two admin tabs or an upload racing a rename can no longer lose an update. Use it for any new handler that edits `files`, `title` or `secrets`.
- **Subrequest budget**: every R2 or DO call is one subrequest and Workers Free allows 50 per request. Admin operations that touch many objects are paginated by cursor and sized below that budget (`PAGE_ALBUMS` 25, `PAGE_VERIFY_FILES` 20 entries, `PAGE_ATTACH_FILES` 20, GC pages in `gc.js`); the admin UI loops until `done`. Keep new admin endpoints within the budget or paginate them the same way.
- Shared objects are never deleted by album/photo operations. Reclaiming space is an explicit admin GC (`POST photos/gc`), which skips objects younger than `PHOTO_GC_GRACE_MS` (default 1h) so an in-flight upload is never collected.
- **Trash**: `DELETE album/<id>` copies `info.json` to `trash/albums/<id>/<timestamp>.json` before deleting it (`src/api/admin/trash.js`); the admin UI lists and restores trash entries. Trash is metadata only: GC does not count refs in trash as referenced, so restoring after a GC may leave entries that verify-files then drops.
- Secrets: `{ secrets: { "abc…": {}, "def…": {} } }` (keys are the secrets, values reserved). Extraction lives in `src/utils/albumSecrets.js`. **New secrets must be at least `MIN_ALBUM_SECRET_LENGTH` (16) chars** (`src/utils/validate.js:isStrongAlbumSecret`): the secret is also the HMAC key of every signed image URL, so a short one can be brute-forced offline from a single leaked URL. Generated secrets are 20 hex chars (`albums.js:generateAlbumSecret`, mirrored in `admin.template.html:generateSecret`). Secrets that already exist on an album are accepted on `PUT` regardless of length, so old albums keep working; the admin UI flags them as weak.

**Validation** (`src/utils/validate.js`):
- albumId: `^[a-zA-Z0-9_.-]{1,128}$` (dots allowed for date-prefixed IDs like `2025.12.25-sunny-family-beach`)
- secret: `^[a-zA-Z0-9_-]{1,256}$` (must be URL-fragment safe)
- photo file name: JPEG only (`.jpg`/`.jpeg`), no leading dot, no path separators, ≤160 chars, `^[a-zA-Z0-9][a-zA-Z0-9._ -]*$`. `normalizeJpgName()` strips paths and forces a `.jpg` extension.

## Download all as ZIP

The gallery offers "Download all as ZIP" for albums that fit the limits. **The Worker never builds archives**: Workers Free allows 10 ms CPU and 50 subrequests per request, while a ZIP needs a CRC-32 over every byte and one R2 read per photo. The browser does the work from the signed original URLs it already holds.

**Server side** (`src/utils/albumZip.js`, called from `src/api/album.js`):
- `zipPolicy(entries, env)` returns `{ enabled, available, reason, fileCount, totalBytes, sizeKnown, maxFiles, maxBytes }`; the album response exposes it as `zip`. `reason` is checked in this order: `disabled` (`ZIP_DOWNLOAD=0`), `empty`, `too_many_files` (`ZIP_MAX_FILES`, default 100), `too_large` (`ZIP_MAX_BYTES`, default 500 MiB), `size_unknown` (some entry lacks `size`), else `null`.
- The 100-file default is not arbitrary: it keeps one download under the 300/min `RL_IMG` limit. Raise both together. Raising `ZIP_MAX_BYTES` past 4 GiB would require ZIP64 in the client writer.
- Sizes come from `files[].size` (see R2 data layout). They are written by upload (`photo.size`, or the existing object's size when the ref already exists and `overwrite` is not set), by attach (`head()` result) and by verify-files, which rewrites `info.json` whenever a size is missing or differs and reports `sizeUpdated`. The public path never calls `head()` for sizes. **After deploying to an existing bucket, run "Verify files (all)" once** to backfill.
- Unit tests: `test/albumZip.test.js`; e2e (sizes on upload/attach, `size_unknown` → verify → available): `test/worker.test.js`.

**Client side** (`public/ui.js`, toolbar markup and styles in `index.template.html`):
- `renderZipToolbar()` renders `#toolbar` from `data.zip`. Nothing is shown for `empty` / `disabled`. Unavailable albums still get the button (`aria-disabled`, greyed) plus a short hint; clicking prints `zipUnavailableMessage(zip)` with the actual numbers. Keep that behaviour: the visitor must always see *why* there is no download.
- `createZipWriter(sink)` (`public/zip.js`) is a self-contained streaming writer: STORE, flags `0x0808` (data descriptor + UTF-8), DOS timestamps, central directory + EOCD, no ZIP64. `crc32Update(crc, bytes)` is incremental (start at 0). Names are album file names (ASCII by validation) so no encoding edge cases. No third-party library and no WebAssembly, so `public/_headers` CSP stays unchanged; do not swap in `client-zip` or similar without checking the CSP (`wasm-unsafe-eval`).
- The writer lives in `public/zip.js` (ES module, unit-tested in `test/zip.test.js`); `ui.js` is loaded as `<script type="module">` and imports it.
- `openZipSink(fileName)` must be called inside the click handler: `showSaveFilePicker` needs a user gesture. Chromium streams to disk via `FileSystemWritableFileStream`; elsewhere chunks are collected into a Blob and saved through a temporary `<a download>`. `AbortError` from the picker means the user cancelled (no error shown).
- `downloadAlbumZip()` fetches originals sequentially with `credentials: 'same-origin'`, retries `429` up to twice honouring `Retry-After` (capped at 60 s), aborts if the streamed total exceeds `maxBytes`, and calls `sink.abort()` on any failure so no partial file is left. Cancel uses an `AbortController`.
- `test/zip.test.js` parses the produced archive (local headers, data descriptors, central directory, EOCD, CRC vectors). For a browser smoke test set `window.showSaveFilePicker = undefined` before clicking to force the Blob path (the native save dialog cannot be driven by automation).

## Authentication model

**Album access**: Secret is passed in the URL fragment (`/<albumId>#<secret>`). The client reads `location.hash` and POSTs `{ secret, turnstileToken }` to `/api/album/<albumId>` (first attempt without a token, see "Early album fetch" below; Turnstile only on 403). The Worker starts the `info.json`/secret check before the Turnstile soft-counter round-trip so the two overlap, and validates without logging or persisting the secret. Response includes `Server-Timing` (per-phase timings) and `X-OhMyPhoto-FileCount` headers, `Cache-Control: no-store`.

**Signed image URLs**: The album response returns URLs `/img/<albumId>/(photos|preview)/<ref>?s=<sig>` with `sig = HMAC-SHA256(key = secret, msg = "albumId:ref")` hex (`src/utils/crypto.js:imageSig`). Original URLs also carry `&n=<file name>`; it is not signed and only sets `Content-Disposition: inline; filename="<name>"` (validated with `isValidPhotoFileName`) so a saved photo gets its album name instead of the hash. Other extra query params (`r=` cache-buster used by the grid's retry) are ignored. The album ID stays in the URL so access is per-album even though the object is shared. The admin UI computes the same HMAC client-side (`admin.template.html:imageSig`) — keep the two in sync. `src/api/image.js` first checks the Cloudflare edge cache (Cache API, key = full URL incl. signature, `X-OhMyPhoto-Cache: HIT|MISS`); on a miss it validates the signature against *every* secret with `timingSafeEqual` (no early exit), streams `photos/<ref>.jpg` / `previews/<ref>.jpg` from R2 with `Cache-Control: public, max-age=31536000, immutable, s-maxage=<edge>` (objects are content-addressed, so immutable) and stores the response via `ctx.waitUntil`. Trade-off: after a secret rotation, URLs already cached at an edge keep working up to `IMAGE_EDGE_MAX_AGE_S` (default 86400; `0` disables edge caching).

**Admin**: Two-step.
1. `POST /api/admin/session` with `{ token: <ADMIN_TOKEN>, turnstileToken? }`. Turnstile is verified here if `TURNSTILE_SECRET_KEY` is set. On success returns an HMAC-SHA256 session token (signed with `ADMIN_TOKEN`, 7-day TTL, `src/utils/session.js`).
2. All other `/api/admin/*` calls require `Authorization: Bearer <sessionToken>`. The raw `ADMIN_TOKEN` is **not** accepted as a Bearer value.

The admin UI stores the session token under `ohmyphoto_admin_session` in `localStorage`, falling back to `sessionStorage` (iOS Safari private mode).

**Turnstile (bot protection)**: Opt-in via `TURNSTILE_SECRET_KEY`. Soft enforcement on the album endpoint: **only suspicious requests count**, i.e. a wrong secret (403) or an unknown album (404) sent without a token and without the bypass cookie. A request with a valid secret never moves the counter, so the photographer testing links or many visitors behind one NAT never trigger the captcha. Once an IP accumulates `TURNSTILE_SOFT_THRESHOLD` (default 256) such requests within `TURNSTILE_SOFT_WINDOW_MS` (default 24h), Turnstile is required synchronously (403 `Bot verification required`; the client then runs the widget and retries). Below threshold a supplied token is verified in `ctx.waitUntil` and counted only on failure. A 500 (broken `info.json`) is never counted. The bypass cookie (`ohmyphoto_human`, HttpOnly, IP-bound, HMAC-signed, sliding TTL, default 7 days via `TURNSTILE_BYPASS_COOKIE_TTL_MS`) is issued on every response with a valid secret and after a passed challenge, so a returning browser skips even the counter peek. The soft branch is covered by `test/turnstileSoft.test.js`, which calls `handleAlbumRequest` directly with `TURNSTILE_SECRET_KEY` set (the e2e config blanks it).

## Rate limiting

`src/utils/rateLimit.js` runs before routing. Native Cloudflare Rate Limiting bindings only support 10s/60s periods, so long windows stay on the Durable Object:

| Path | Bucket | Mechanism | Limit |
|---|---|---|---|
| `POST /api/admin/session` | `admin_session` | `RateLimiterDO` | 10 / 10 min |
| `/api/admin/*` | `admin_api` | `RL_ADMIN_API` | 60 / min |
| `/api/album/*` | `album_api` | `RL_ALBUM_API` | 120 / min |
| `/img/*` | `img` | `RL_IMG` | 300 / min |
| other | `other` | `RL_OTHER` | 120 / min |

Native limits are edited in `wrangler.toml`; the `fallback` values in `rateLimit.js` mirror them for environments without the bindings (DO path, keyed `"<bucket>:<ip>"`). Returns 429 with `RateLimit-*` and `Retry-After`. Disabled with `RATE_LIMIT_DISABLED=1`. Always fail-open on errors/timeouts (`RATE_LIMIT_TIMEOUT_MS`, default 500, DO path only).

## Durable Objects

**`RateLimiterDO`** (`src/durable/rateLimiter.js`): Stores `{ count, resetAtMs }`. Actions over POST JSON: `check` (default, `{ limit, windowMs }`), `peek`, `adjust` (`{ delta, windowMs }`), `reset`. Turnstile soft counters use instance name `turnstile_soft:<ip>`.

**`AlbumInfoDO`** (`src/durable/albumInfo.js`): Instance name `album:<albumId>`. Caches parsed `info.json` + extracted secrets. TTLs: hits 7 days (`ALBUM_INFO_TTL_MS`), 404s 1 hour (`ALBUM_INFO_NOT_FOUND_TTL_MS`), parse errors 60s (`ALBUM_INFO_PARSE_ERROR_TTL_MS`). Actions: `get` (`withStats: true` also returns the view stats in the same round-trip), `invalidate`, and the view counters `hit`, `stats`, `importStats`, `resetStats`. Both DOs keep an in-memory memo (`this.mem`) in front of storage — in tests use a fresh albumId per test. **Every admin write that touches an album must call `invalidateAlbumCache()`** (`src/utils/album.js`), including both old and new IDs on rename. `putInfoJson()` in `src/api/admin/infoStore.js` does this automatically.

**Album view statistics** live in the same DO under a separate storage key (`stats`), so `invalidate` never resets them: `{ since, lastAt, total, bySecret: { <secret>: n } }`. One view = one `POST /api/album/<id>` answered 200 (valid secret); wrong secret, unknown album and 500 are never counted, so this is page loads per link, not unique visitors. `src/api/album.js` records it via `recordAlbumView()` (`src/utils/album.js`) inside `ctx.waitUntil`, best-effort, so the response never waits for the DO. `since` is the timestamp of the first counted view (null until then); `ALBUM_VIEWS=0` disables counting. The admin list gets `views: { since, lastAt, total, bySecret }` for free through `getAlbumInfoWithSecrets(id, env, { withStats: true })` (same DO call, no extra subrequest); the album page reads the full breakdown from `GET album/<id>/stats`. Rename moves the counters to the new id (`moveAlbumStats`: `stats` + `importStats` + `resetStats`, best-effort); trash/restore under the same id keeps them, restore under a new id starts from zero. Helpers: `getAlbumStats`, `importAlbumStats`, `resetAlbumStats`, `mergeAlbumStats` (exported from `albumInfo.js`).

DO calls from the album/rate-limit paths use `Promise.race()` with a timeout and fail-open. `getAlbumInfoWithSecrets()` has no timeout but falls back to direct R2 read if the DO errors or returns an unexpected shape.

## Admin API (`src/api/admin/`)

- `index.js` — route table (`ROUTES`: method + regex + handler, `public: true` skips auth). Capture groups arrive URL-decoded as `params`. Unknown paths still require auth before 404.
- `auth.js` — `authorizeAdmin`, session exchange.
- `albums.js` — paged list/create/update(+rename)/delete (delete goes to trash).
- `trash.js` — trash for deleted albums' `info.json`: move, list, restore, purge.
- `files.js` — upload (with de-dup), attach existing refs (chunked), rename/delete photos, raw image, photo existence check, paged verify-files.
- `gc.js` — orphan GC for `photos/` + `previews/` (two-phase, batched by cursor, snapshot in `gc/`).
- `ai.js` — Workers AI ID/title generation.
- `infoStore.js` — `info.json` read/write helpers (`putInfoJson` invalidates the DO cache; `updateInfoJson` = ETag-conditional read-modify-write with retry), `listAlbumIds` (one page of the R2 delimiter listing, never scans photo objects), page-size constants, `files` entry manipulation (`getFileEntries`, `upsertInfoFile`, `withFileEntries`), `mapLimit`.

All under `/api/admin/`, Bearer session token required except `session`:

| Method + path | Purpose |
|---|---|
| `POST session` | Exchange `ADMIN_TOKEN` for session token |
| `GET albums?cursor=` | One page (`PAGE_ALBUMS`) of `{ albumId, title, secretCount, secrets, fileCount, views }` plus `{ cursor, done }` (delimiter listing + one `info.json` read per album, `views = { since, lastAt, total, bySecret }` from the same DO call or `null` without the binding; `fileCount` counts only valid entries, same as the gallery). Client follows `cursor` |
| `POST album` | Create `{ albumId, title?, secret? }`; secret auto-generated as 20 hex chars if omitted; 400 if a supplied secret is shorter than 16 chars; 409 if exists |
| `PUT album/<id>` | Update `{ title?, secrets?: string[], newAlbumId? }`. Secrets not already on the album must be ≥16 chars (400). Title/secrets are written with `updateInfoJson` (ETag retry). Rename = put new `info.json`, delete old, invalidate both DO caches; 409 if the destination exists |
| `GET album/<id>/stats` | View counters `{ albumId, since, lastAt, total, bySecret }` (404 if the album does not exist; `bySecret` may include secrets removed since) |
| `DELETE album/<id>/stats` | Reset the counters and `since` to zero |
| `DELETE album/<id>` | Copy `info.json` to `trash/albums/<id>/<ts>.json`, then delete it; returns `trashKey`. Shared `photos/` objects are left for GC |
| `GET trash` | Trashed albums `{ items: [{ key, albumId, deletedAt, size }], truncated }` (one list call, newest first) |
| `POST trash/restore` | `{ key, albumId? }` puts the trashed `info.json` back (under `albumId` if given) and removes the trash object; 409 if the album exists |
| `DELETE trash/<key>` | Drop one trash object for good (`key` URL-encoded) |
| `GET album/<id>/files` | Entries `{ name, ref, size?, photoUrl, previewUrl }` with admin raw URLs |
| `GET album/<id>/raw/(photos\|preview)/<ref>` | Stream image without signature (`no-store`) |
| `GET photo/<ref>` | `{ ref, exists, hasPreview }` via two `head()` calls; the admin UI calls this before converting/uploading |
| `POST album/<id>/file` | `multipart/form-data`: `photo`, `preview` (both must start with JPEG magic `FF D8 FF`), optional `name`, `ref` (sha256 hex of the source), `overwrite=1`. Shared objects are written only if missing (or overwrite); 409 if `name` exists in the album with a different ref. Returns `{ name, ref, size, stored }`. With `ref` supplied the photo is streamed, otherwise buffered once to hash it |
| `POST album/<id>/files` | Attach existing photos: `{ files: [{ name, ref }], overwrite? }` (≤`PAGE_ATTACH_FILES` = 20 per request; the admin UI sends chunks and asks once about all conflicts). Verifies each `photos/<ref>.jpg` with `head()` (400 + `missing` otherwise), 409 + `conflicts` on name clashes. Used for de-duplicated uploads and "add from another album"; nothing is copied |
| `PUT album/<id>/file/<name>` | Rename `{ newName }` — metadata-only; 409 if `newName` is taken |
| `DELETE album/<id>/file/<name>` | Remove entry from `files`; the object stays |
| `POST photos/gc` | `{ dryRun? (default true), cursor? }`. A run has two phases chained by `cursor` (`"<phase>\|<runId>\|<state>"`): `refs` walks the albums one page at a time and accumulates referenced refs in `gc/<runId>.json`; `scan` walks `photos/` then `previews/` one list page (1000) per request, deletes objects not in the snapshot and older than `PHOTO_GC_GRACE_MS`, and deletes the snapshot when done. Returns `{ phase, runId, done, cursor, albumCount, referencedRefs, orphanCount, orphans (≤200), deleted, ... }`; a stale/garbage cursor is 400. Client loops on `cursor` |
| `POST album/<id>/verify-files` | `{ cursor? }`. Drops entries that are not valid `{ name, ref }` (bare names from the old layout, duplicates) and counts them in `invalid`; then checks the next `PAGE_VERIFY_FILES` entries after `cursor` (a file name) with one `head()` pair each: drops entries whose photo is missing, records/refreshes `size`. Returns `{ fileCount, checked, invalid, removed, missingPreviewCount, sizeUpdated, cursor, done }`. Written with `updateInfoJson`. "Verify files (all)" in the admin UI is this loop over every album, driven by the browser |
| `POST generate-album-id` | Workers AI: `{ description }` → `{ albumId, title }` |

**AI generation**: Album ID = UTC date prefix `YYYY.MM.DD-` + 3–4 word lowercase kebab slug (retries once with a stricter prompt). Title is generated in parallel and is best-effort (empty string on failure). Models/knobs via env: `AI_ALBUM_ID_MODEL` (default `@cf/meta/llama-2-7b-chat-int8`, set in `wrangler.toml [vars]`), `AI_ALBUM_ID_MAX_TOKENS`, `AI_ALBUM_ID_TEMPERATURE`, `AI_ALBUM_ID_TOP_P`, and `AI_ALBUM_TITLE_*` equivalents (fall back to the ID model).

## Client

- `src/client/index.template.html` → `public/index.html` (gallery shell: grid, lightbox, Turnstile widgets). Gallery logic lives in `public/ui.js` (ES module, tracked in git, **not** generated), the ZIP writer in `public/zip.js`.
- Lightbox (`ui.js:initLightbox`): real `<button>`s for close/prev/next (focus moves to close on open and back on close), counter `i / n`, file name, `Download` link (`<a download>` on the signed original, so the file gets its album name), Esc/arrows/Home/End, horizontal swipe via pointer events (ignored with two pointers so pinch-zoom still works), neighbours preloaded. Grid `alt` is the file name without extension; a failed preview (429 from `RL_IMG` on shared networks, flaky network) is retried 3 times with growing delay using an `&r=` cache-buster.
- Access/error cards speak the visitor's language ("access code", "the part of the link after #"), never `albumId`/`secret`.
- **Early album fetch**: an inline script at the top of `<head>` (before the stylesheet) POSTs `/api/album/<id>` immediately and stores the promise in `window.__ohmyphotoAlbumFetch` (+ `__ohmyphotoAlbumFetchKey = "albumId#secret"`). `ui.js:fetchAlbumOnce` reuses it for the first token-less request, so the API round-trip overlaps CSS/JS download. Keep the request body identical in both places.
- Album toolbar (`#toolbar`, inside `.header-brand` in the sticky header, directly under the album title): "Download all as ZIP" button, rendered from `data.zip` (see "Download all as ZIP" above). Hidden for empty albums or `ZIP_DOWNLOAD=0`.
- Grid images: first 8 `loading="eager"`, first 4 `fetchpriority="high"`, rest lazy (`EAGER_IMAGES` / `HIGH_PRIORITY_IMAGES` in `ui.js`).
- `public/styles.css` is a local copy of `https://plushka.se/styles.css` (background `url()`s rewritten to absolute plushka.se URLs). Served immutable for a year, so bump the `?v=` in the template whenever it changes. Re-sync manually if the main site's styles change.
- `src/client/admin.template.html` → `public/admin.html`. Single-file admin app (~1500 lines) with a hash router so browser back/forward work: `#/` album list, `#/new` create form, `#/album/<id>` album page, `#/trash`. `route()` runs on load and on `hashchange`; without a valid session only the login card is shown (top bar and all views hidden), and a 401 from any admin call drops the session and returns to it. The list page shows per album only id/title, photo count, views, share links + QR (with per-link `weak` / views badges) and a "Manage" link; everything that edits one album (title, secrets, rename, delete → trash, upload with drag & drop, "add photos from another album" picker, rename/remove photos, verify files) lives on the album page. The list has a Views column (total, tooltip with the start date and last visit) and, instead of a Secrets column, a `weak` / `N views` badge on each share link (`no secrets` badge when the album has none); the album page's Share card shows each link with its full secret (`renderAlbumLinks` with `showSecret`), a `N views` badge per link, the secrets editor (textarea, `+ generated secret`, `Save secrets` → `PUT { secrets }` only, `saveAlbumSecrets`), a line "N views since <date>, last <date>" (plus views via removed links) and a Reset views button (`loadAlbumStats`, `renderAlbumViews`, `GET/DELETE album/<id>/stats`). The Settings card below holds only Title and Rename (`saveAlbumSettings` → `PUT { title, newAlbumId? }`); both go through `putCurrentAlbum`. Storage-wide actions (GC orphans, Verify files (all), Refresh, New album) stay in the list header; Trash is a top-bar link. Messages use a toast (`notify()`), destructive actions still use `confirm()`. `lastAlbums` caches the paged list; the album page reloads it when the id is not cached (deep link, after create/restore). QR codes via `public/vendor/qr-code-styling.esm.js` (vendored, loaded with dynamic `import()`). Upload per file: SHA-256 of the source (`sha256HexOfFile`) → `GET photo/<ref>`; if the object exists it is attached via `POST album/<id>/files` without conversion, otherwise the image is converted client-side (canvas) to JPEG 3000px + 1000px preview and uploaded with the `ref`. The upload zone has an "Also add the uploaded photos to other albums" picker (checkbox list of the other albums from `lastAlbums`, `fillAlsoAddList`): after the batch, every successfully attached/uploaded `{ name, ref }` is attached to each ticked album via `attachFilesChunked` (shared with "add photos from another album": `PAGE_ATTACH_FILES`-sized `POST album/<id>/files` requests, one `confirm()` per album for name conflicts). Metadata-only, nothing is copied. GC loops on `cursor` until `done` (dry run, confirm, delete).
- `public/_headers` sets security headers + CSP for static assets, plus long immutable caching for `/styles.css` and `/vendor/*`. Allow-listed external origins: `challenges.cloudflare.com` (Turnstile script/frame/connect) and `plushka.se` (two CSS background images only). Adding any new external resource requires a CSP update.
- Both templates contain the placeholder `__TURNSTILE_SITE_KEY__`. `scripts/build-assets.mjs` reads `TURNSTILE_SITE_KEY` from env or `.dev.vars` and substitutes it; unset yields `YOUR_TURNSTILE_SITE_KEY`, which the client treats as "Turnstile disabled". Wrangler runs the build automatically (`[build]` in `wrangler.toml`, watch on `src/client/`).
- `public/index.html` and `public/admin.html` are gitignored (`public/.gitignore`). Edit the templates, never the outputs.

## Environment variables

Secrets (`.dev.vars` locally, `wrangler secret put` in prod): `ADMIN_TOKEN`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (build-time only).

Optional tuning (all read with defaults in code): `TURNSTILE_SOFT_THRESHOLD`, `TURNSTILE_SOFT_WINDOW_MS`, `TURNSTILE_SOFT_DO_TIMEOUT_MS` (default 80), `TURNSTILE_SOFT_PEEK_TIMEOUT_MS`, `TURNSTILE_SOFT_ADJUST_TIMEOUT_MS`, `TURNSTILE_VERIFY_TIMEOUT_MS` (default 5000), `TURNSTILE_BYPASS_COOKIE` (`0` disables), `TURNSTILE_BYPASS_COOKIE_NAME`, `TURNSTILE_BYPASS_COOKIE_TTL_MS`, `RATE_LIMIT_DISABLED`, `RATE_LIMIT_TIMEOUT_MS`, `ALBUM_INFO_TTL_MS`, `ALBUM_INFO_NOT_FOUND_TTL_MS`, `ALBUM_INFO_PARSE_ERROR_TTL_MS`, `ALBUM_VIEWS` (`0` disables view counting), `PHOTO_GC_GRACE_MS` (default 3600000), `IMAGE_EDGE_MAX_AGE_S`, `ZIP_DOWNLOAD` (`0` disables), `ZIP_MAX_FILES` (default 100), `ZIP_MAX_BYTES` (default 524288000), `AI_*` (see above).

## Local environment

`.dev.vars` is gitignored; copy `.dev.vars.example` (test Turnstile keys, `ADMIN_TOKEN=dev-admin`). Prod uses Worker secrets set via `wrangler secret put`. Never commit `.dev.vars`: the repository is public. Turnstile test keys (`1x000...`) skip real verification. Local R2 can be seeded via `cp_albums_local.sh` from a local `r2/` directory (untracked) mirroring the bucket layout (`r2/photos/<ref>.jpg`, `r2/previews/<ref>.jpg`, `r2/albums/<id>/info.json`); uploading through the admin UI is usually simpler. Admin UI: `http://127.0.0.1:8787/admin.html`.

## Conventions

- Small pure helpers in `src/utils/*`; handlers in `src/api/*`; each DO in `src/durable/*` with its protocol documented in a JSDoc header. No backward-compatibility shims: there is one storage layout and one `files` entry format.
- Admin handlers that modify `info.json` use `updateInfoJson`; admin handlers that touch many objects are paginated (see "Subrequest budget").
- Responses go through `src/utils/response.js` (`json`, `jsonNoStore`, `text`, `notFound`, `forbidden`, `badRequest`, `conflict`). Admin handlers return `jsonNoStore`.
- Anything touching secrets, tokens or signatures uses `timingSafeEqual` from `src/utils/crypto.js`; HMAC helpers live there too.
- R2 existence checks use `head()`, not `get()`. Never list R2 on a public request path; batched admin maintenance only.
- Observability is enabled in `wrangler.toml` (logs persisted, 100% sampling); traces disabled.
