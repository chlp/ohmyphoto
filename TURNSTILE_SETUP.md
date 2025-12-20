# Cloudflare Turnstile setup (bot protection)

This project uses **Cloudflare Turnstile (captcha)** to reduce bot traffic.

## Setup steps

### 0) Local development defaults (committed test keys)

This repo includes a committed `.dev.vars` with **Cloudflare Turnstile test keys** for local development:

- Site key: `1x00000000000000000000AA`
- Secret key: `1x0000000000000000000000000000000AA`

These are **testing-only** and provide **no real bot protection** in production. For production, set your own keys (see steps below).

### 1) Create Turnstile keys

1. Open Cloudflare Dashboard
2. Go to **Turnstile**
3. Create a new site (or use an existing one)
4. Choose **Invisible** mode
5. Copy your **Site Key** (public) and **Secret Key** (server-side)

### 2) Configure the Site Key (client)

You have two options:

**Option A (recommended): use an environment variable during build**

- Set the Site Key in your environment before `wrangler dev` / `wrangler deploy` (locally you can put it into `.dev.vars` if you want):

```bash
TURNSTILE_SITE_KEY=0x4AAAAAAABkMYinukVmVUL
```

The build step will inject it into `public/index.html`.

**Option B: hardcode it in the template**

Open `src/client/index.template.html` and replace:

```javascript
const TURNSTILE_SITE_KEY = '__TURNSTILE_SITE_KEY__';
```

with:

```javascript
const TURNSTILE_SITE_KEY = '0x4AAAAAAABkMYinukVmVUL';
```

### 3) Configure the Secret Key (Worker)

Add the secret key as a Cloudflare Worker secret:

**Via Wrangler CLI:**

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
# Paste your Secret Key when prompted
```

**Via Cloudflare Dashboard:**

1. Workers & Pages → your worker
2. Settings → Variables
3. Add secret `TURNSTILE_SECRET_KEY` with your Secret Key value

### 4) Verify it works

- If Turnstile is configured, requests to the API will be verified
- If keys are not configured, the app still works (bot protection is effectively disabled)
- You may see console warnings if Turnstile fails to load

## Disabling Turnstile temporarily

- Set `TURNSTILE_SITE_KEY` to `YOUR_TURNSTILE_SITE_KEY` (or just don’t set it at all)
- Or remove `TURNSTILE_SECRET_KEY` from Worker secrets

## Turnstile modes

- **Invisible** (recommended): fully hidden from the user
- **Managed**: shows a challenge only when traffic looks suspicious
- **Non-interactive**: lightweight challenge

This repo is currently wired for **Invisible** mode.

