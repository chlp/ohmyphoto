# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

```bash
# Local dev server (Cloudflare Workers via Wrangler)
npx wrangler dev

# Build static assets (templates → public/index.html, public/admin.html)
node scripts/build-assets.mjs

# Copy local album fixtures (./albums/**) into local R2 (local dev only)
bash cp_albums_local.sh
```

No `package.json`, no test suite, no lint config. Wrangler is invoked via `npx`. Related docs: `README.md` (feature overview), `USAGE.md` (Russian end-user guide for the admin UI).

## Architecture

**Runtime**: Cloudflare Workers (no Node.js). All code must use Workers-compatible APIs (`crypto.subtle`, `fetch`, `Response`, `URL`, etc.). Plain ES modules, no bundler.

**Entry point**: `src/worker.js` — applies per-IP rate limiting (`src/utils/rateLimit.js`) then delegates to `src/router.js`. Also re-exports both Durable Object classes.

**Routing** (`src/router.js`):
- `/api/admin/*` → `src/api/admin.js` (checked first)
- `POST /api/album/<albumId>` → `src/api/album.js`
- `GET /img/<albumId>/(photos|preview)/<name>` → `src/api/image.js`
- Anything else → 404 from the Worker. Static assets are served by the Assets binding *before* the Worker for all paths except `/api/*` and `/img/*` (`run_worker_first` in `wrangler.toml`), with SPA fallback so `/<albumId>` serves `index.html`.

**Cloudflare bindings** (`wrangler.toml`):
| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 (`ohmyphoto`) | Album data storage |
| `RATE_LIMITER` | Durable Object `RateLimiterDO` | Per-IP rate limiting + Turnstile soft counters |
| `ALBUM_INFO` | Durable Object `AlbumInfoDO` | Persistent cache for `info.json` per album |
| `AI` | Workers AI | Album ID / title generation |
| `ASSETS` | Static | Serves `public/` |

DO migrations: `v1` RateLimiterDO, `v2` AlbumIndexDO (added), `v3` AlbumInfoDO, `v4` AlbumIndexDO deleted. Do not reuse the class name `AlbumIndexDO`.

**R2 data layout**:
```
albums/<albumId>/info.json       # { title, secret|secrets, files: [] }
albums/<albumId>/photos/<name>   # original images (JPEG)
albums/<albumId>/preview/<name>  # preview images (JPEG, same file name)
```

- `info.json.files` is the **authoritative photo list**. The public album endpoint never lists R2; if `files` is missing it returns 500. Admin writes keep `files` sorted with `localeCompare` and de-duplicated.
- Secret formats: legacy `{ secret: "abc" }` or canonical `{ secrets: { "abc": {}, "def": {} } }`. Extraction lives in `src/utils/albumSecrets.js`. Admin updates rewrite to the `secrets` object and delete the legacy `secret` key.

**Validation** (`src/utils/validate.js`):
- albumId: `^[a-zA-Z0-9_.-]{1,128}$` (dots allowed for date-prefixed IDs like `2025.12.25-sunny-family-beach`)
- secret: `^[a-zA-Z0-9_-]{1,256}$` (must be URL-fragment safe)
- photo file name: JPEG only (`.jpg`/`.jpeg`), no leading dot, no path separators, ≤160 chars, `^[a-zA-Z0-9][a-zA-Z0-9._ -]*$`. `normalizeJpgName()` strips paths and forces a `.jpg` extension.

## Authentication model

**Album access**: Secret is passed in the URL fragment (`/<albumId>#<secret>`). `public/ui.js` reads `location.hash` and POSTs `{ secret, turnstileToken }` to `/api/album/<albumId>`. The Worker validates against `info.json` without logging or persisting the secret. Response includes `Server-Timing` (per-phase timings) and `X-OhMyPhoto-FileCount` headers, `Cache-Control: no-store`.

**Signed image URLs**: The album response returns photo/preview URLs with `?s=<sig>` where `sig = sha256hex("albumId:name:secret")` (`src/utils/crypto.js:imageSig`). `src/api/image.js` accepts a signature matching *any* secret of the album, then streams from R2 with `Cache-Control: public, max-age=3600`. No Turnstile or rate-limit-heavy logic on the image path.

**Admin**: Two-step.
1. `POST /api/admin/session` with `{ token: <ADMIN_TOKEN>, turnstileToken? }`. Turnstile is verified here if `TURNSTILE_SECRET_KEY` is set. On success returns an HMAC-SHA256 session token (signed with `ADMIN_TOKEN`, 7-day TTL, `src/utils/session.js`).
2. All other `/api/admin/*` calls require `Authorization: Bearer <sessionToken>`. The raw `ADMIN_TOKEN` is **not** accepted as a Bearer value.

The admin UI stores the session token under `ohmyphoto_admin_session` in `localStorage`, falling back to `sessionStorage` (iOS Safari private mode).

**Turnstile (bot protection)**: Opt-in via `TURNSTILE_SECRET_KEY`. Soft enforcement on the album endpoint: requests pass freely until an IP accumulates `TURNSTILE_SOFT_THRESHOLD` (default 100) unverified requests within `TURNSTILE_SOFT_WINDOW_MS` (default 24h). Below threshold, a supplied token is verified in `ctx.waitUntil` and the counter is incremented only on failure. Above threshold, Turnstile is required synchronously. After passing, the Worker sets an HttpOnly, IP-bound, HMAC-signed bypass cookie (`ohmyphoto_human`) with sliding TTL. Default cookie TTL is 7 days (`TURNSTILE_BYPASS_COOKIE_TTL_MS`).

## Rate limiting

`src/utils/rateLimit.js` runs before routing. Buckets keyed `"<bucket>:<ip>"` in `RateLimiterDO`:

| Path | Bucket | Limit |
|---|---|---|
| `POST /api/admin/session` | `admin_session` | 10 / 10 min |
| `/api/admin/*` | `admin_api` | 300 / 5 min |
| `/api/album/*` | `album_api` | 120 / 1 min |
| `/img/*` | `img` | 1200 / 5 min |
| other | `other` | 600 / 5 min |

Returns 429 with `RateLimit-*` and `Retry-After` headers. Disabled with `RATE_LIMIT_DISABLED=1`. Fail-open on DO timeout (`RATE_LIMIT_TIMEOUT_MS`, default 500).

## Durable Objects

**`RateLimiterDO`** (`src/durable/rateLimiter.js`): Stores `{ count, resetAtMs }`. Actions over POST JSON: `check` (default, `{ limit, windowMs }`), `peek`, `adjust` (`{ delta, windowMs }`), `reset`. Turnstile soft counters use instance name `turnstile_soft:<ip>`.

**`AlbumInfoDO`** (`src/durable/albumInfo.js`): Instance name `album:<albumId>`. Caches parsed `info.json` + extracted secrets (default TTL 7 days via `ALBUM_INFO_TTL_MS`; parse errors cached for `ALBUM_INFO_PARSE_ERROR_TTL_MS`, default 60s; 404s cached for the full TTL). Actions: `get`, `invalidate`. **Every admin write that touches an album must call `invalidateAlbumCache()`** (`src/utils/album.js`), including both old and new IDs on rename. `putInfoJson()` in `admin.js` does this automatically.

DO calls from the album/rate-limit paths use `Promise.race()` with a timeout and fail-open. `getAlbumInfoWithSecrets()` has no timeout but falls back to direct R2 read if the DO errors or returns an unexpected shape.

## Admin API (`src/api/admin.js`)

All under `/api/admin/`, Bearer session token required except `session`:

| Method + path | Purpose |
|---|---|
| `POST session` | Exchange `ADMIN_TOKEN` for session token |
| `GET albums` | List `{ albumId, title, secretCount, secrets }` (scans `albums/*/info.json`) |
| `POST album` | Create `{ albumId, title?, secret? }`; secret auto-generated as 6 hex chars if omitted; 409 if exists |
| `PUT album/<id>` | Update `{ title?, secrets?: string[], newAlbumId? }`; rename copies every key under the prefix then deletes the old ones (batches of 100) |
| `DELETE album/<id>` | Delete all keys under `albums/<id>/` |
| `GET album/<id>/files` | Files from `info.json` with admin raw URLs |
| `GET album/<id>/raw/(photos\|preview)/<name>` | Stream image without signature (`no-store`) |
| `POST album/<id>/file` | `multipart/form-data`: `photo`, `preview` (both JPEG), optional `name`, `overwrite=1`; 409 if exists without overwrite |
| `PUT album/<id>/file/<name>` | Rename `{ newName }` (copies photo+preview, deletes old) |
| `DELETE album/<id>/file/<name>` | Delete photo + preview, remove from `files` |
| `POST album/<id>/rebuild-files` | Rebuild `files` from R2 `photos/` listing; reports added/removed/missing previews |
| `POST albums/rebuild-files` | Same for all albums |
| `POST generate-album-id` | Workers AI: `{ description }` → `{ albumId, title }` |

**AI generation**: Album ID = UTC date prefix `YYYY.MM.DD-` + 3–4 word lowercase kebab slug (retries once with a stricter prompt). Title is best-effort (empty string on failure). Models/knobs via env: `AI_ALBUM_ID_MODEL` (default `@cf/meta/llama-2-7b-chat-int8`, set in `wrangler.toml [vars]`), `AI_ALBUM_ID_MAX_TOKENS`, `AI_ALBUM_ID_TEMPERATURE`, `AI_ALBUM_ID_TOP_P`, and `AI_ALBUM_TITLE_*` equivalents (fall back to the ID model).

## Client

- `src/client/index.template.html` → `public/index.html` (gallery shell: grid, lightbox, Turnstile widgets). Gallery logic lives in `public/ui.js` (tracked in git, **not** generated). Images use `loading="lazy"`.
- `src/client/admin.template.html` → `public/admin.html`. Single-file admin app (~1100 lines): login, album CRUD, upload/rename/delete photos, rebuild files, AI generate, QR codes for share links via `public/vendor/qr-code-styling.esm.js` (vendored, loaded with dynamic `import()`).
- Both templates contain the placeholder `__TURNSTILE_SITE_KEY__`. `scripts/build-assets.mjs` reads `TURNSTILE_SITE_KEY` from env or `.dev.vars` and substitutes it; unset yields `YOUR_TURNSTILE_SITE_KEY`, which the client treats as "Turnstile disabled". Wrangler runs the build automatically (`[build]` in `wrangler.toml`, watch on `src/client/`).
- `public/index.html` and `public/admin.html` are gitignored (`public/.gitignore`). Edit the templates, never the outputs.

## Environment variables

Secrets (`.dev.vars` locally, `wrangler secret put` in prod): `ADMIN_TOKEN`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` (build-time only).

Optional tuning (all read with defaults in code): `TURNSTILE_SOFT_THRESHOLD`, `TURNSTILE_SOFT_WINDOW_MS`, `TURNSTILE_SOFT_DO_TIMEOUT_MS` (default 80), `TURNSTILE_SOFT_PEEK_TIMEOUT_MS`, `TURNSTILE_SOFT_ADJUST_TIMEOUT_MS`, `TURNSTILE_VERIFY_TIMEOUT_MS` (default 5000), `TURNSTILE_BYPASS_COOKIE` (`0` disables), `TURNSTILE_BYPASS_COOKIE_NAME`, `TURNSTILE_BYPASS_COOKIE_TTL_MS`, `RATE_LIMIT_DISABLED`, `RATE_LIMIT_TIMEOUT_MS`, `ALBUM_INFO_TTL_MS`, `ALBUM_INFO_PARSE_ERROR_TTL_MS`, `AI_*` (see above).

## Local environment

`.dev.vars` (not committed):
```
TURNSTILE_SECRET_KEY=...
TURNSTILE_SITE_KEY=...
ADMIN_TOKEN=...
```

Use `ADMIN_TOKEN=dev-admin` locally. Turnstile test keys (`1x000...`) skip real verification. Local R2 is populated via `cp_albums_local.sh` from a local `albums/` directory (untracked). Admin UI: `http://127.0.0.1:8787/admin.html`.

## Conventions

- Small pure helpers in `src/utils/*`; handlers in `src/api/*`; each DO in `src/durable/*` with its protocol documented in a JSDoc header.
- Responses go through `src/utils/response.js` (`json`, `text`, `notFound`, `forbidden`). Admin JSON responses use `Cache-Control: no-store`.
- Anything touching secrets or tokens uses `timingSafeEqual` from `src/utils/crypto.js`.
- Observability is enabled in `wrangler.toml` (logs persisted, 100% sampling); traces disabled.
