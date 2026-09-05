# ohmyphoto
Private photo gallery web service.

This is a **minimal private photo gallery** built on **Cloudflare Workers + R2**:

- **Storage**: photos/previews and album metadata live in **Cloudflare R2**
- **Photos are stored once, content-addressed**, and shared between albums:
  - `photos/<sha256>.jpg` original image, `previews/<sha256>.jpg` preview
  - the hash is computed from the original source file in the browser, so re-uploading the same photo (into any album, from any device) never stores a second copy
- **Albums** are just lists of references: `albums/<albumId>/info.json` holds title, secrets and `files: [{ name, ref, size }]`
  - renaming an album or a photo, deleting a photo from an album, or building a new gallery from existing photos touches only `info.json` — no objects are copied or moved
  - every edit of `info.json` is an ETag-conditional write with retry, so concurrent admin sessions never lose an update
  - deleting an album keeps its `info.json` in a **trash** (restorable from the admin UI); unreferenced photos are reclaimed by an explicit **GC**
  - photos are ordered by file name in natural order (`2.jpg` before `10.jpg`)

### “PrivateBin style” secret via URL hash

The album secret is provided in the URL fragment: `/<albumId>#<secret>`.

- **The `#...` fragment is not sent in HTTP requests** (so it doesn’t end up in server logs/referrers by default)
- The page’s JavaScript reads `location.hash` and sends the secret to the Worker **only to authenticate** access to the album
- The Worker validates it against `info.json` and **does not persist** the secret anywhere
- Generated secrets are 20 hex characters and new secrets must be at least 16 characters: the secret is also the key that signs every photo URL, so a short secret could be brute-forced offline from a single shared image link

## Download all as ZIP

Visitors can download every original of an album as a single `.zip` from a button above the photo grid.

**Why the browser builds the archive.** Cloudflare Workers Free gives a request 10 ms of CPU and 50 subrequests. A ZIP needs a CRC-32 over every byte and one R2 read per photo, so even a modest album blows through both limits. Instead the gallery page fetches the signed original URLs it already has (`/img/<albumId>/photos/<ref>?s=...`) and writes the archive itself. The Worker's only role is to say whether the download is allowed; R2 egress is free, so the download costs nothing extra.

**How it works**

- Format: plain ZIP, method STORE (JPEGs don't compress), UTF-8 names, data descriptors so files stream without knowing sizes up front. No ZIP64, which is fine under the 4 GiB / 65535-entry ceiling enforced by the limits below. Verified with `unzip` and macOS Archive Utility.
- Saving: Chromium browsers (Chrome, Edge, Brave) open a save dialog and stream the archive straight to disk, so memory stays flat. Firefox and Safari build the archive in memory and then trigger a normal download; the 500 MB cap keeps that workable on desktop, on phones very large albums may still fail.
- Progress and cancel are shown next to the button. Photos are fetched one by one; a `429` from the image rate limit is retried after `Retry-After`.
- The client stops with an error if the streamed bytes exceed the configured maximum, even when the server-side estimate said it would fit.

**Limits (server-side, per album)**

| Variable | Default | Meaning |
|---|---|---|
| `ZIP_MAX_FILES` | `100` | Maximum number of photos. Also keeps one download under the 300/min `/img` rate limit |
| `ZIP_MAX_BYTES` | `524288000` (500 MiB) | Maximum total size of originals |
| `ZIP_DOWNLOAD` | `1` | Set to `0` to hide the feature entirely |

The album API response carries the verdict in `zip: { available, reason, fileCount, totalBytes, sizeKnown, maxFiles, maxBytes }`. For albums over a limit the button stays visible but disabled, with a short hint next to it; clicking it prints the exact reason, e.g. *"it has 132 photos, and the archive download is limited to 100 photos"*. Photographers who need to hand over a bigger shoot can create a favourites album from the same photos (nothing is copied) or split the shoot into several albums.

**Photo sizes.** The size check relies on a `size` field per entry in `info.json`, recorded automatically on upload and when attaching existing photos. Albums created before this feature have no sizes, and the gallery reports the download as unavailable ("photo sizes have not been recorded"). Run **Verify files (all)** once in the admin UI after deploying; it backfills the sizes from R2.

## Bot protection (Cloudflare Turnstile captcha)

- **Enable/disable**: if `TURNSTILE_SECRET_KEY` is set, the Worker will require Turnstile verification; if it’s unset, bot protection is effectively disabled.
- **Client flow**: the client tries to obtain a Turnstile token (invisible first, with a UI fallback if needed).
- **No captcha on every request**: after a successful verification, the Worker issues a **short-lived signed HttpOnly “human bypass” cookie** (configurable) so subsequent API calls can skip Turnstile until it expires.
- **Soft enforcement (new)**: Turnstile is only *required* for an IP after it makes more than `TURNSTILE_SOFT_THRESHOLD` album API requests within `TURNSTILE_SOFT_WINDOW_MS` **without** a valid bypass cookie and **without** passing Turnstile. Before the threshold is exceeded, requests are allowed to proceed without waiting; if a token is provided, the Worker verifies it in the background and only increments the counter if verification fails (so successful requests don’t mutate the counter).
- **Soft enforcement env vars**:
  - `TURNSTILE_SOFT_THRESHOLD` (default: `100`)
  - `TURNSTILE_SOFT_WINDOW_MS` (default: `86400000` i.e. 24h)
  - `TURNSTILE_SOFT_DO_TIMEOUT_MS` (default: `80`) – best-effort timeout for the DO calls (fail-open)
- **Signed image URLs**: photo/preview URLs include a signature (`?s=...`, HMAC-SHA256 keyed by the album secret), so the browser can fetch images without re-sending the secret (and without re-running Turnstile per image). Objects are content-addressed and immutable, so image responses are cached at the Cloudflare edge for a day (`IMAGE_EDGE_MAX_AGE_S`) and in the browser for a year.
- `TURNSTILE_SOFT_DO_TIMEOUT_MS` defaults to `80` ms in code (the Durable Object calls are best-effort and fail open).

## Rate limiting

Per-IP limits use Cloudflare's native Rate Limiting bindings (`[[ratelimits]]` in `wrangler.toml`) for the album, image and admin APIs, and a Durable Object for the admin login endpoint (10 attempts / 10 minutes). Set `RATE_LIMIT_DISABLED=1` to turn it off locally.

## Gallery for visitors

- Grid of previews; the lightbox has close/prev/next buttons, keyboard navigation (Esc, arrows, Home/End), swipe on touch screens, a `1 / 42` counter, the file name and a **Download** link that saves the original under its album name.
- A preview that fails to load (for example the per-IP image rate limit when a whole family shares one connection) is retried automatically.
- Error pages explain what to do in plain words ("the access code is the part of the link after #").

## Admin (create/update/rename/delete albums)

Open `/admin` (for example: `http://127.0.0.1:8787/admin.html` when running locally). The UI shows a login form until a session exists, then a list of albums; each album has its own page (`#/album/<id>`) with share links, photos, settings and delete, so browser back/forward work.

Login exchanges `ADMIN_TOKEN` (a Worker secret in production) for a signed 7-day session token; all other admin calls send `Authorization: Bearer <sessionToken>`.

**Free-plan friendly.** A Worker on the Free plan may make 50 subrequests per request, and every R2 or Durable Object call counts. Admin operations that touch many objects (album list, verify files, attaching photos, GC) are therefore paginated and the admin UI loops through the pages, so the service keeps working with hundreds of albums.

## Local run

```bash
npm install
cp .dev.vars.example .dev.vars   # local ADMIN_TOKEN + Turnstile test keys (gitignored)
npx wrangler dev                 # http://127.0.0.1:8787
npm test                         # vitest inside workerd (R2/DO/rate-limit simulators)
```

Tests also run in GitHub Actions on every push and pull request.

Static assets get security headers and a CSP from `public/_headers`.