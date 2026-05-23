# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

```bash
# Local dev server (Cloudflare Workers via Wrangler)
npx wrangler dev

# Build static assets (templates → public/)
node scripts/build-assets.mjs

# Copy local album fixtures into R2 (local dev only)
bash cp_albums_local.sh
```

No test suite or lint config exists in this project.

## Architecture

**Runtime**: Cloudflare Workers (no Node.js). All code must use Workers-compatible APIs (`crypto.subtle`, `fetch`, `Response`, `URL`, etc.).

**Entry point**: `src/worker.js` — applies rate limiting then delegates to `src/router.js`.

**Routing** (`src/router.js`):
- `POST /api/album/<albumId>` → `src/api/album.js`
- `GET /img/<albumId>/(photos|preview)/<name>` → `src/api/image.js`
- `/api/admin/*` → `src/api/admin.js`
- All other paths fall through to static assets (`public/`) via Cloudflare Assets binding

**Cloudflare bindings** (defined in `wrangler.toml`):
| Binding | Type | Purpose |
|---|---|---|
| `BUCKET` | R2 | Album data storage |
| `RATE_LIMITER` | Durable Object | Per-IP rate limiting + Turnstile soft counters |
| `ALBUM_INFO` | Durable Object | Persistent cache for `info.json` per album |
| `AI` | Workers AI | Album ID / title generation |
| `ASSETS` | Static | Serves `public/` |

**R2 data layout**:
```
albums/<albumId>/info.json       # { title, secret|secrets, files: [] }
albums/<albumId>/photos/<name>   # original images
albums/<albumId>/preview/<name>  # preview images
```

`info.json` supports two secret formats: `{ secret: "abc" }` or `{ secrets: { "abc": any, "def": any } }`. Extraction logic lives in `src/utils/albumSecrets.js`.

## Authentication model

**Album access**: Secret is passed in the URL fragment (`/<albumId>#<secret>`). The client JS reads `location.hash` and POSTs `{ secret, turnstileToken }` to `/api/album/<albumId>`. The Worker validates against `info.json` without logging or persisting the secret.

**Signed image URLs**: After authenticating, the Worker returns photo/preview URLs with `?s=<sig>` where `sig = sha256hex("albumId:name:secret")` (`src/utils/crypto.js:imageSig`). This lets the browser fetch images without re-sending the secret.

**Admin**: `Authorization: Bearer <ADMIN_TOKEN>`. After one successful login, the server issues a short-lived HMAC-SHA256 signed session token (7-day TTL). Subsequent requests use the session token as the Bearer value.

**Turnstile (bot protection)**: Opt-in via `TURNSTILE_SECRET_KEY`. Soft enforcement: requests are allowed freely until an IP exceeds `TURNSTILE_SOFT_THRESHOLD` (default 100) unverified requests within `TURNSTILE_SOFT_WINDOW_MS` (default 24h). After passing Turnstile, the Worker sets a short-lived HttpOnly bypass cookie (HMAC-SHA256, IP-bound, sliding TTL).

## Durable Objects

**`RateLimiterDO`** (`src/durable/rateLimiter.js`): Keyed by `"<bucket>:<ip>"`. Supports `check`, `peek`, `adjust`, `reset` actions over POST. Also used for Turnstile soft counters keyed by `"turnstile_soft:<ip>"`.

**`AlbumInfoDO`** (`src/durable/albumInfo.js`): Keyed by `"album:<albumId>"`. Caches `info.json` + extracted secrets persistently (default TTL 7 days). Call `invalidate` action after any admin write that modifies album data.

All Durable Object calls use `Promise.race()` with a timeout and fail-open (never block the main response on a DO timeout).

## Client build

`src/client/index.template.html` and `src/client/admin.template.html` contain the placeholder `__TURNSTILE_SITE_KEY__`. `scripts/build-assets.mjs` reads `.dev.vars` (or `TURNSTILE_SITE_KEY` env var), substitutes the placeholder, and writes to `public/index.html` and `public/admin.html`. Wrangler runs this automatically on `wrangler dev` (watch mode on `src/client/`).

## Local environment

`.dev.vars` (not committed) provides secrets to Wrangler locally:
```
TURNSTILE_SECRET_KEY=...
TURNSTILE_SITE_KEY=...
ADMIN_TOKEN=...
```

Use `ADMIN_TOKEN=dev-admin` locally. Turnstile test keys (`1x000...`) skip real verification.

## Admin UI

Open `http://127.0.0.1:8787/admin.html` locally. Admin API endpoints live under `/api/admin/` and use Bearer auth. AI-powered album ID and title generation require the `AI` binding (Workers AI) to be available.
