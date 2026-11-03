# Deployment: Cloudflare Pages (frontend)

The React frontend (`frontend/`) is a static site deployed to **Cloudflare Pages** with Cloudflare's official CLI, Wrangler (a dev dependency, pinned).
The API runs as a separate Worker (`backend-workers/`) reached through Pages Functions on the same origin; see *API* below. The ASP.NET Core API is unchanged and not deployed.

## Configuration in the repo
| File | Purpose |
|---|---|
| `frontend/wrangler.toml` | Pages project name (`progineer-ims`) and build output (`./dist`). No Workers code, no secrets |
| `frontend/public/_headers` | Security headers on every response (CSP allowing only self, Google Fonts and Google Identity Services; `X-Frame-Options: DENY`; `nosniff`; HSTS; strict referrer), plus long-term caching of hashed assets |
| SPA routing | No `404.html` is shipped, so Pages serves `index.html` for unknown paths and React Router handles `/sign-in`, `/admin/…` and other deep links |
| `VITE_API_BASE_URL` (build-time, optional) | Absolute API URL when the API lives on another origin. Default `/api` (same origin). If set, also add that origin to `connect-src` in `_headers` and to the API's `Cors:AllowedOrigins` |

## Deploy
```bash
cd frontend
nvm use
npx wrangler login            # once: browser-based OAuth approval of your Cloudflare account
npm run deploy                # type-check + build, then `wrangler pages deploy` (creates the project on first run)
```
Credentials are stored by Wrangler in your user profile, never in the repo. For CI, use a scoped `CLOUDFLARE_API_TOKEN` secret (Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`, never committed.

## API: the Worker behind the Pages site (same origin)

```
browser ──► https://progineer-ims.pages.dev
              ├─ static React build (dist/)                       all other paths
              └─ Pages Functions (frontend/functions/)            /api/*  and  /health
                    └─ service binding "API" ──► Worker "ims-api" (backend-workers/, no public URL)
                                                    └─ pg over TLS (verify-full) ──► Neon ims_db (pooled host)
```

- The browser only talks to `progineer-ims.pages.dev`, so the `SameSite=Strict`, `Secure`, `HttpOnly` session cookie works and CORS stays off.
- The Worker has no route, no `workers.dev` and no preview URL; only the Pages project can call it.
- `frontend/wrangler.toml` declares the binding (`[[services]] binding = "API", service = "ims-api"`). The two functions forward the request unchanged.
- Free plan: each API call is one Pages Function invocation plus one Worker invocation (100,000 requests per day in total); static files are free and unlimited.

### Deploy (in this order)
```bash
# 1. Worker (backend-workers/): code first, then the secrets
cd backend-workers
npx wrangler deploy
npx wrangler secret put DATABASE_URL      # Neon pooled host, sslmode=verify-full, no channel_binding
npx wrangler secret put SESSION_SECRET    # openssl rand -base64 48
# 2. Site (frontend/): the build with the functions and the binding
cd ../frontend && npm run deploy
```
Deploying the site before the Worker exists breaks `/api` (the binding has nothing to call).

### Check
- `https://progineer-ims.pages.dev/health` → `Healthy` (Worker → Neon).
- `/api/auth/config` → the client id and the staff domains `["stu.najah.edu", "progineer.net"]` (AD-45).
- `/api/auth/me` → 401 when signed out.

### Current deployment (2026-11-03, Admin audit log viewer)
- Worker `ims-api` version `043dcafa-fcdc-4c9f-b1c9-fa7c38b238fe` (previous: `e7c0bda6-c9c9-4b1f-a320-82e21762ad23`, the mentor profile release); secrets `DATABASE_URL`, `SESSION_SECRET` set.
- Pages production deployment `11ae7ac8-4027-41e9-b5e6-339a57870f4f` (previous: `8bed5dfc-7245-413d-aaf7-19ec6001bb70`).
- Known, separately tracked: the Worker's database account owns `audit_logs` and can bypass its append-only protection (audit inspection 2026-11-03); not changed by this release.
- No database migration (the reports only read).

### Rollback
- **Site:** Cloudflare dashboard → Pages → progineer-ims → Deployments → the previous deployment (`8bed5dfc…`) → *Rollback*, or redeploy that commit.
- **Worker:** `npx wrangler rollback e7c0bda6-c9c9-4b1f-a320-82e21762ad23` (in `backend-workers/`).

Neither touches the database.

### Google sign-in
In Google Cloud Console → the OAuth Web client, **Authorized JavaScript origins** must contain `https://progineer-ims.pages.dev` (and `http://localhost:4200` for development). No client secret is used.

## Before the API (history)
Until the Worker was added, the Pages site served only the static app, and `/api/*` answered with the app's HTML (shown as "service not available").
