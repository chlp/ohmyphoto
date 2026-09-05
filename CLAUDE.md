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

`npm install` first. No lint config. Related docs: `README.md` (feature overview), `USAGE.md` (Russian end-user guide for the admin UI).

**Tests** live in `test/*.test.js`; config in `vitest.config.mjs`. They run against the real `wrangler.toml` bindings with local R2/DO/rate-limit simulators, `remoteBindings: false` (Workers AI is never called), `TURNSTILE_SECRET_KEY` blanked, `RATE_LIMIT_DISABLED=1` (the e2e suite exceeds the 60/min admin limit; limiter logic is covered in `durable.test.js`) and `PHOTO_GC_GRACE_MS=0`. `test/worker.test.js` drives the full Worker via `SELF.fetch()`; add an end-to-end case there for any new admin route. R2 state is shared between tests in a file and shared photos are keyed by content hash, so each test gets unique JPEG bytes (`beforeEach`) and unique album IDs.

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
| `ALBUM_INFO` | Durable Object `AlbumInfoDO` | Persistent cache for `info.json` per album |
| `AI` | Workers AI | Album ID / title generation |
| `ASSETS` | Static | Serves `public/` |

DO migrations: `v1` RateLimiterDO, `v2` AlbumIndexDO (added), `v3` AlbumInfoDO, `v4` AlbumIndexDO deleted. Do not reuse the class name `AlbumIndexDO`.

**R2 data layout** (content-addressed, photos shared between albums):
```
photos/<ref>.jpg                 # original (JPEG), ref = sha256 hex (64 chars) of the source file
previews/<ref>.jpg               # preview (JPEG), same ref
albums/<albumId>/info.json       # { title, secrets, files: [ { name, ref, size? }, ... ] }
```

- An album is **only its `info.json`**. `files` is the authoritative photo list: the public album endpoint never lists R2; if `files` is missing it returns 500. Each entry is `{ name, ref, size? }`; `name` is the display name, unique within an album; `ref` is the storage identity and may appear in many albums; `size` is the byte size of the original, recorded on upload/attach and backfilled by verify-files (used only by the ZIP gate below). Anything else in `files` is ignored. Parsing lives in `src/utils/albumFiles.js` (`parseFileEntries`, `imageObjectKey`). The gallery renders entries in array order; admin writes keep `files` sorted with `localeCompare` and de-duplicated by name.
- A photo's `ref` is computed by the admin UI as SHA-256 of the **original source file** (before canvas conversion), so re-uploading the same photo from any device or into any album de-duplicates. If the upload omits `ref`, the server hashes the uploaded JPEG bytes instead.
- Renaming an album or a photo, deleting a photo from an album and composing a new album from existing photos only rewrite `info.json`; objects are never copied or moved.
- **Listing rule**: nothing on the public path (`/api/album`, `/img`) ever lists R2; existence checks use `head()` on `photos/<ref>.jpg`. Listing happens only in the admin album list (delimiter listing of `albums/`) and in GC (one 1000-key page per request).
- Shared objects are never deleted by album/photo operations. Reclaiming space is an explicit admin GC (`POST photos/gc`), which skips objects younger than `PHOTO_GC_GRACE_MS` (default 1h) so an in-flight upload is never collected.
- Secrets: `{ secrets: { "abc": {}, "def": {} } }` (keys are the secrets, values reserved). Extraction lives in `src/utils/albumSecrets.js`.

**Validation** (`src/utils/validate.js`):
- albumId: `^[a-zA-Z0-9_.-]{1,128}$` (dots allowed for date-prefixed IDs like `2025.12.25-sunny-family-beach`)
- secret: `^[a-zA-Z0-9_-]{1,256}$` (must be URL-fragment safe)
- photo file name: JPEG only (`.jpg`/`.jpeg`), no leading dot, no path separators, ≤160 chars, `^[a-zA-Z0-9][a-zA-Z0-9._ -]*$`. `normalizeJpgName()` strips paths and forces a `.jpg` extension.

## Authentication model

**Album access**: Secret is passed in the URL fragment (`/<albumId>#<secret>`). The client reads `location.hash` and POSTs `{ secret, turnstileToken }` to `/api/album/<albumId>` (first attempt without a token, see "Early album fetch" below; Turnstile only on 403). The Worker starts the `info.json`/secret check before the Turnstile soft-counter round-trip so the two overlap, and validates without logging or persisting the secret. Response includes `Server-Timing` (per-phase timings) and `X-OhMyPhoto-FileCount` headers, `Cache-Control: no-store`.

**Download all as ZIP** (`src/utils/albumZip.js`, `ui.js`): the archive is built **in the visitor's browser** from the signed original URLs (STORE, no compression, own ~150-line streaming writer in `ui.js`, no library). The Worker never zips: Workers Free has 10 ms CPU and 50 subrequests per request. The album response carries the verdict in `zip: { available, reason, fileCount, totalBytes, sizeKnown, maxFiles, maxBytes }`; `reason` ∈ `too_many_files | too_large | size_unknown | empty | disabled | null`. Limits: `ZIP_MAX_FILES` (default 100, also keeps one download under the 300/min `/img` rate limit) and `ZIP_MAX_BYTES` (default 500 MiB); `ZIP_DOWNLOAD=0` hides the feature. `size_unknown` means some entry lacks `size` (album written before sizes existed): run **Verify files** for that album. The gallery shows the button even when unavailable and prints the exact reason on click; the client also aborts if the streamed bytes exceed `maxBytes`. Saving uses `showSaveFilePicker` (streams to disk, Chromium) and falls back to an in-memory Blob + `<a download>`.

**Signed image URLs**: The album response returns URLs `/img/<albumId>/(photos|preview)/<ref>?s=<sig>` with `sig = HMAC-SHA256(key = secret, msg = "albumId:ref")` hex (`src/utils/crypto.js:imageSig`). The album ID stays in the URL so access is per-album even though the object is shared. The admin UI computes the same HMAC client-side (`admin.template.html:imageSig`) — keep the two in sync. `src/api/image.js` first checks the Cloudflare edge cache (Cache API, key = full URL incl. signature, `X-OhMyPhoto-Cache: HIT|MISS`); on a miss it validates the signature against *every* secret with `timingSafeEqual` (no early exit), streams `photos/<ref>.jpg` / `previews/<ref>.jpg` from R2 with `Cache-Control: public, max-age=31536000, immutable, s-maxage=<edge>` (objects are content-addressed, so immutable) and stores the response via `ctx.waitUntil`. Trade-off: after a secret rotation, URLs already cached at an edge keep working up to `IMAGE_EDGE_MAX_AGE_S` (default 86400; `0` disables edge caching).

**Admin**: Two-step.
1. `POST /api/admin/session` with `{ token: <ADMIN_TOKEN>, turnstileToken? }`. Turnstile is verified here if `TURNSTILE_SECRET_KEY` is set. On success returns an HMAC-SHA256 session token (signed with `ADMIN_TOKEN`, 7-day TTL, `src/utils/session.js`).
2. All other `/api/admin/*` calls require `Authorization: Bearer <sessionToken>`. The raw `ADMIN_TOKEN` is **not** accepted as a Bearer value.

The admin UI stores the session token under `ohmyphoto_admin_session` in `localStorage`, falling back to `sessionStorage` (iOS Safari private mode).

**Turnstile (bot protection)**: Opt-in via `TURNSTILE_SECRET_KEY`. Soft enforcement on the album endpoint: requests pass freely until an IP accumulates `TURNSTILE_SOFT_THRESHOLD` (default 100) unverified requests within `TURNSTILE_SOFT_WINDOW_MS` (default 24h). Below threshold, a supplied token is verified in `ctx.waitUntil` and the counter is incremented only on failure. Above threshold, Turnstile is required synchronously. After passing, the Worker sets an HttpOnly, IP-bound, HMAC-signed bypass cookie (`ohmyphoto_human`) with sliding TTL. Default cookie TTL is 7 days (`TURNSTILE_BYPASS_COOKIE_TTL_MS`).

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

**`AlbumInfoDO`** (`src/durable/albumInfo.js`): Instance name `album:<albumId>`. Caches parsed `info.json` + extracted secrets. TTLs: hits 7 days (`ALBUM_INFO_TTL_MS`), 404s 1 hour (`ALBUM_INFO_NOT_FOUND_TTL_MS`), parse errors 60s (`ALBUM_INFO_PARSE_ERROR_TTL_MS`). Actions: `get`, `invalidate`. Both DOs keep an in-memory memo (`this.mem`) in front of storage — in tests use a fresh albumId per test. **Every admin write that touches an album must call `invalidateAlbumCache()`** (`src/utils/album.js`), including both old and new IDs on rename. `putInfoJson()` in `src/api/admin/infoStore.js` does this automatically.

DO calls from the album/rate-limit paths use `Promise.race()` with a timeout and fail-open. `getAlbumInfoWithSecrets()` has no timeout but falls back to direct R2 read if the DO errors or returns an unexpected shape.

## Admin API (`src/api/admin/`)

- `index.js` — route table (`ROUTES`: method + regex + handler, `public: true` skips auth). Capture groups arrive URL-decoded as `params`. Unknown paths still require auth before 404.
- `auth.js` — `authorizeAdmin`, session exchange.
- `albums.js` — list/create/update(+rename)/delete.
- `files.js` — upload (with de-dup), attach existing refs, rename/delete photos, raw image, photo existence check, verify-files.
- `gc.js` — orphan GC for `photos/` + `previews/` (batched by cursor).
- `ai.js` — Workers AI ID/title generation.
- `infoStore.js` — `info.json` read/write helpers (`putInfoJson` invalidates the DO cache), `listAlbumIds` (R2 delimiter listing, never scans photo objects), `files` entry manipulation (`getFileEntries`, `upsertInfoFile`, `withFileEntries`), `mapLimit`.

All under `/api/admin/`, Bearer session token required except `session`:

| Method + path | Purpose |
|---|---|
| `POST session` | Exchange `ADMIN_TOKEN` for session token |
| `GET albums` | List `{ albumId, title, secretCount, secrets, fileCount }` (delimiter listing + one `info.json` read per album) |
| `POST album` | Create `{ albumId, title?, secret? }`; secret auto-generated as 6 hex chars if omitted; 409 if exists |
| `PUT album/<id>` | Update `{ title?, secrets?: string[], newAlbumId? }`. Rename = put new `info.json`, delete old, invalidate both DO caches; 409 if the destination exists |
| `DELETE album/<id>` | Delete `info.json`; shared `photos/` objects are left for GC |
| `GET album/<id>/files` | Entries `{ name, ref, size?, photoUrl, previewUrl }` with admin raw URLs |
| `GET album/<id>/raw/(photos\|preview)/<ref>` | Stream image without signature (`no-store`) |
| `GET photo/<ref>` | `{ ref, exists, hasPreview }` via two `head()` calls; the admin UI calls this before converting/uploading |
| `POST album/<id>/file` | `multipart/form-data`: `photo`, `preview` (both must start with JPEG magic `FF D8 FF`), optional `name`, `ref` (sha256 hex of the source), `overwrite=1`. Shared objects are written only if missing (or overwrite); 409 if `name` exists in the album with a different ref. Returns `{ name, ref, size, stored }`. With `ref` supplied the photo is streamed, otherwise buffered once to hash it |
| `POST album/<id>/files` | Attach existing photos: `{ files: [{ name, ref }], overwrite? }` (≤1000). Verifies each `photos/<ref>.jpg` with `head()` (400 + `missing` otherwise), 409 + `conflicts` on name clashes. Used for de-duplicated uploads and "add from another album"; nothing is copied |
| `PUT album/<id>/file/<name>` | Rename `{ newName }` — metadata-only; 409 if `newName` is taken |
| `DELETE album/<id>/file/<name>` | Remove entry from `files`; the object stays |
| `POST photos/gc` | `{ dryRun? (default true), cursor? }`. Walks `photos/` then `previews/` one list page (1000) per request, deletes objects not referenced by any `info.json` and older than `PHOTO_GC_GRACE_MS`; returns `{ done, cursor, orphanCount, orphans (≤200), deleted, ... }`. Client loops on `cursor` |
| `POST album/<id>/verify-files` | `head()` every entry's objects; drop entries whose photo is missing, record/refresh each entry's `size`; `{ fileCount, removed, missingPreviewCount, sizeUpdated }`. No listing |
| `POST albums/verify-files` | Same for all albums |
| `POST generate-album-id` | Workers AI: `{ description }` → `{ albumId, title }` |

**AI generation**: Album ID = UTC date prefix `YYYY.MM.DD-` + 3–4 word lowercase kebab slug (retries once with a stricter prompt). Title is generated in parallel and is best-effort (empty string on failure). Models/knobs via env: `AI_ALBUM_ID_MODEL` (default `@cf/meta/llama-2-7b-chat-int8`, set in `wrangler.toml [vars]`), `AI_ALBUM_ID_MAX_TOKENS`, `AI_ALBUM_ID_TEMPERATURE`, `AI_ALBUM_ID_TOP_P`, and `AI_ALBUM_TITLE_*` equivalents (fall back to the ID model).

## Client

- `src/client/index.template.html` → `public/index.html` (gallery shell: grid, lightbox, Turnstile widgets). Gallery logic lives in `public/ui.js` (tracked in git, **not** generated).
- **Early album fetch**: an inline script at the top of `<head>` (before the stylesheet) POSTs `/api/album/<id>` immediately and stores the promise in `window.__ohmyphotoAlbumFetch` (+ `__ohmyphotoAlbumFetchKey = "albumId#secret"`). `ui.js:fetchAlbumOnce` reuses it for the first token-less request, so the API round-trip overlaps CSS/JS download. Keep the request body identical in both places.
- Album toolbar (`#toolbar`, above the grid): "Download all as ZIP" button, rendered from `data.zip` (see "Download all as ZIP" above). Hidden for empty albums or `ZIP_DOWNLOAD=0`.
- Grid images: first 8 `loading="eager"`, first 4 `fetchpriority="high"`, rest lazy (`EAGER_IMAGES` / `HIGH_PRIORITY_IMAGES` in `ui.js`).
- `public/styles.css` is a local copy of `https://plushka.se/styles.css` (background `url()`s rewritten to absolute plushka.se URLs). Served immutable for a year, so bump the `?v=` in the template whenever it changes. Re-sync manually if the main site's styles change.
- `src/client/admin.template.html` → `public/admin.html`. Single-file admin app (~1250 lines): login, album CRUD, upload/rename/delete photos, "add photos from another album" picker (attaches refs, copies nothing), GC orphans / verify files buttons, AI generate, QR codes for share links via `public/vendor/qr-code-styling.esm.js` (vendored, loaded with dynamic `import()`). Upload per file: SHA-256 of the source (`sha256HexOfFile`) → `GET photo/<ref>`; if the object exists it is attached via `POST album/<id>/files` without conversion, otherwise the image is converted client-side (canvas) to JPEG 3000px + 1000px preview and uploaded with the `ref`. GC loops on `cursor` until `done` (dry run, confirm, delete).
- `public/_headers` sets security headers + CSP for static assets, plus long immutable caching for `/styles.css` and `/vendor/*`. Allow-listed external origins: `challenges.cloudflare.com` (Turnstile script/frame/connect) and `plushka.se` (two CSS background images only). Adding any new external resource requires a CSP update.
- Both templates contain the placeholder `__TURNSTILE_SITE_KEY__`. `scripts/build-assets.mjs` reads `TURNSTILE_SITE_KEY` from env or `.dev.vars` and substitutes it; unset yields `YOUR_TURNSTILE_SITE_KEY`, which the client treats as "Turnstile disabled". Wrangler runs the build automatically (`[build]` in `wrangler.toml`, watch on `src/client/`).
- `public/index.html` and `public/admin.html` are gitignored (`public/.gitignore`). Edit the templates, never the outputs.

## Environment variables

Secrets (`.dev.vars` locally, `wrangler secret put` in prod): `ADMIN_TOKEN`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (build-time only).

Optional tuning (all read with defaults in code): `TURNSTILE_SOFT_THRESHOLD`, `TURNSTILE_SOFT_WINDOW_MS`, `TURNSTILE_SOFT_DO_TIMEOUT_MS` (default 80), `TURNSTILE_SOFT_PEEK_TIMEOUT_MS`, `TURNSTILE_SOFT_ADJUST_TIMEOUT_MS`, `TURNSTILE_VERIFY_TIMEOUT_MS` (default 5000), `TURNSTILE_BYPASS_COOKIE` (`0` disables), `TURNSTILE_BYPASS_COOKIE_NAME`, `TURNSTILE_BYPASS_COOKIE_TTL_MS`, `RATE_LIMIT_DISABLED`, `RATE_LIMIT_TIMEOUT_MS`, `ALBUM_INFO_TTL_MS`, `ALBUM_INFO_NOT_FOUND_TTL_MS`, `ALBUM_INFO_PARSE_ERROR_TTL_MS`, `PHOTO_GC_GRACE_MS` (default 3600000), `IMAGE_EDGE_MAX_AGE_S`, `ZIP_DOWNLOAD` (`0` disables), `ZIP_MAX_FILES` (default 100), `ZIP_MAX_BYTES` (default 524288000), `AI_*` (see above).

## Local environment

`.dev.vars` holds local-only values (prod uses Worker secrets set via `wrangler secret put`):
```
TURNSTILE_SECRET_KEY=...
TURNSTILE_SITE_KEY=...
ADMIN_TOKEN=...
```

Use `ADMIN_TOKEN=dev-admin` locally. Turnstile test keys (`1x000...`) skip real verification. Local R2 can be seeded via `cp_albums_local.sh` from a local `r2/` directory (untracked) mirroring the bucket layout (`r2/photos/<ref>.jpg`, `r2/previews/<ref>.jpg`, `r2/albums/<id>/info.json`); uploading through the admin UI is usually simpler. Admin UI: `http://127.0.0.1:8787/admin.html`.

## Conventions

- Small pure helpers in `src/utils/*`; handlers in `src/api/*`; each DO in `src/durable/*` with its protocol documented in a JSDoc header. No backward-compatibility shims: there is one storage layout and one `files` entry format.
- Responses go through `src/utils/response.js` (`json`, `jsonNoStore`, `text`, `notFound`, `forbidden`, `badRequest`, `conflict`). Admin handlers return `jsonNoStore`.
- Anything touching secrets, tokens or signatures uses `timingSafeEqual` from `src/utils/crypto.js`; HMAC helpers live there too.
- R2 existence checks use `head()`, not `get()`. Never list R2 on a public request path; batched admin maintenance only.
- Observability is enabled in `wrangler.toml` (logs persisted, 100% sampling); traces disabled.
