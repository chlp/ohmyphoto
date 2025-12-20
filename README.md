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

See [TURNSTILE_SETUP.md](./TURNSTILE_SETUP.md).

## Local run

```bash
npx wrangler dev
```