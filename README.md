# ohmyphoto
Private photo gallery web service.

This is a **minimal private photo gallery** built on **Cloudflare Workers + R2**:

- **Storage**: photos/previews and album metadata live in **Cloudflare R2**
- **Albums**: each album is a folder under `albums/<albumId>/`
  - `albums/<albumId>/info.json` stores album settings (e.g. title/secret)
  - `albums/<albumId>/photos/*` original images
  - `albums/<albumId>/preview/*` preview images

### “PrivateBin style” secret via URL hash

The album secret is provided in the URL fragment: `/<albumId>#<secret>`.

- **The `#...` fragment is not sent in HTTP requests** (so it doesn’t end up in server logs/referrers by default)
- The page’s JavaScript reads `location.hash` and sends the secret to the Worker **only to authenticate** access to the album
- The Worker validates it against `info.json` and **does not persist** the secret anywhere

## Bot protection (Cloudflare Turnstile captcha)

- **Enable/disable**: if `TURNSTILE_SECRET_KEY` is set, the Worker will require Turnstile verification; if it’s unset, bot protection is effectively disabled.
- **Client flow**: the client tries to obtain a Turnstile token (invisible first, with a UI fallback if needed).
- **No captcha on every request**: after a successful verification, the Worker issues a **short-lived signed HttpOnly “human bypass” cookie** (configurable) so subsequent API calls can skip Turnstile until it expires.
- **Soft enforcement (new)**: Turnstile is only *required* for an IP after it makes more than `TURNSTILE_SOFT_THRESHOLD` album API requests within `TURNSTILE_SOFT_WINDOW_MS` **without** a valid bypass cookie and **without** passing Turnstile. Before the threshold is exceeded, requests are allowed to proceed without waiting; if a token is provided, the Worker verifies it in the background and only increments the counter if verification fails (so successful requests don’t mutate the counter).
- **Soft enforcement env vars**:
  - `TURNSTILE_SOFT_THRESHOLD` (default: `100`)
  - `TURNSTILE_SOFT_WINDOW_MS` (default: `86400000` i.e. 24h)
  - `TURNSTILE_SOFT_DO_TIMEOUT_MS` (default: `300`) – best-effort timeout for the DO calls (fail-open)
- **Signed image URLs**: photo/preview URLs include a signature (`?s=...`) derived from the album secret, so the browser can fetch images without re-sending the secret (and without re-running Turnstile per image).

## Admin (create/update/rename/delete albums)

Open `./admin.html` (for example: `http://127.0.0.1:8787/admin.html` when running locally).

Admin API is protected with `Authorization: Bearer <ADMIN_TOKEN>` (set `ADMIN_TOKEN` as a Worker secret in production).

## Local run

```bash
npx wrangler dev
```