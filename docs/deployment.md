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
- Every `/api/*` response carries `Cache-Control: no-store` (unless it sets its own) and `X-Content-Type-Options: nosniff`;
  `/health` keeps its own `no-store, no-cache`. Signed out, an unknown `/api/*` path is 401 (sign-in is required first).
  A request from a foreign `Origin` gets no `Access-Control-*` headers (`CORS_ALLOWED_ORIGINS` is empty: same origin).

### Current deployment (2026-11-07, Admin role governance, AD-56)
- Worker `ims-api` version `6900a9e2-178e-4fb7-875a-2e49d75393e6` and Pages production deployment
  `0551650d-7780-4a22-a7a4-629efc947e13` (commit `316f6ac`, 2026-11-07 13:36 UTC; Worker first, then Pages): owner decisions
  AUD-01 (never zero Admins), AUD-02 (no self-change of role) and AUD-03 (an Admin may change another Admin while one
  remains), enforced by the API with row locks. Same bindings, variables, secrets (`DATABASE_URL`, `SESSION_SECRET`, not
  re-entered) and `_headers`. No migration; no change to tables, triggers, functions, grants or data. Before: 352/352 Worker
  tests (3 runs with Mac sleep prevented; as `ims_app`, disposable local PostgreSQL), 295/295 frontend and 76/76 .NET tests,
  typechecks, lint and builds passed. After: the signed-out checks identical to the pre-deployment baseline; new
  translations and bundle served; read-only Neon catalog, roles, record counts and audit rows unchanged, the Worker
  connected as `ims_app`. The owner tested the rules locally. **Signed-in verification in production: not confirmed**; no
  production account was promoted or demoted for this release. Stale edits by two Admins remain undecided (not part of it).
- Previous (RN-1, HR mentor profile employee filter): Worker `92b6c658-f4b8-4ce7-840e-af99c0a4ab64` and Pages
  `528f0cb3-a425-4eb4-b3d7-9c4e54d49c8f` (commit `eaf01fe`, 2026-11-04; Worker first, then Pages): the HR mentor profile's
  employee filter (PDF §6; optional `employeeId` on `GET /api/hr/reports/mentor-profile`, an Employee selector, filtered
  Excel/PDF export, empty states "No employees yet." / "No matching employees."). Same bindings, variables, secrets
  (`DATABASE_URL`, `SESSION_SECRET`, not re-entered) and `_headers`. Before: 338/338 Worker tests (as `ims_app`,
  disposable local PostgreSQL) and 288/288 frontend tests, typechecks, lint and builds passed. After: the signed-out
  checks (including the report endpoints, 401) identical to the pre-deployment baseline; new translations served;
  read-only Neon catalog and counts unchanged, the Worker connected as `ims_app`. **Owner's signed-in verification in
  production (2026-11-04): the "No matching employees" empty state verified and working.** The other scenarios (choosing
  an employee, filtered Excel/PDF export, All employees, the Employee's own profile) are not yet confirmed.
- Previous (security release): Worker `6c144b0b-bfb4-4f05-a880-a4b1c5eb491b` (commit `8f005fa`, deployed 2026-11-04
  14:28 UTC): the security improvements A1, A2, B1 and B3 below. Same bindings, variables and compatibility settings as before;
  secrets `DATABASE_URL` and `SESSION_SECRET` carried over unchanged (not re-entered). Before the deploy: 337/337 Worker
  tests passed (as `ims_app`, disposable local PostgreSQL), typecheck and dry-run build passed. After it: the signed-out
  checks above passed (GET/OPTIONS only); the only change from the pre-deployment baseline was the two new headers;
  read-only Neon catalog and counts unchanged.
- Before it: `aaa13c87-f4b6-45d2-b9ce-34dd74a89ba7`, the same code as
  `6625ef5c-781a-49a3-96da-908a80f9cae6` (the sign-in audit attribution release) with only the `DATABASE_URL` secret
  changed to `ims_app`.
- **`DATABASE_URL` now connects as `ims_app`** (least-privilege role, Option A; pooled host, `sslmode=verify-full`), no longer as the owner `neondb_owner`. Role, grants and limits: [least-privilege.md](least-privilege.md). Its credential is kept in the developer machine's .NET user-secrets (`ConnectionStrings:NeonApp`); the owner credential (`ConnectionStrings:Neon`) is used for migrations and administration only.
- Previous Pages production deployment `c81d55dc-0891-4289-9fd3-220335a7a045` (commit `6903209`: Excel and PDF report export, AD-55; verified in production by the owner); before it: `11ae7ac8-4027-41e9-b5e6-339a57870f4f`.
- No migration; no change to tables, triggers, functions or data. Pages, Neon, R2 and the secrets were not changed by
  the security release.

### Security assessment (2026-11-04)
Items of the read-only security assessment of 2026-11-04 (its own labels, not the question IDs of
[decisions.md](decisions.md)):

| Item | What | Status |
|---|---|---|
| A1 | Catalog tests: every business table has enabled audit, no-delete and no-truncate triggers; `audit_logs` is append-only and refuses TRUNCATE; a new unprotected table is detected; no event trigger or row-level security | **Done**: tests, commit `8f005fa` |
| A2 | Audit behaviour tests: criterion update, notification settings change, application rejection, trainee profile, attachment metadata (actor, operation, table, values before and after; no file content) | **Done**: tests, commit `8f005fa` |
| B1 | API headers: `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` by default; explicit headers kept (errors and cookies `no-cache,no-store`; files and images `private, no-store`; `/health`) | **Done**: deployed (Worker `6c144b0b`), verified in production |
| B3 | `Retry-After: 60` on the rate limiter's 429 (body and limits unchanged); a test keeps it equal to `"period"` in `wrangler.jsonc` | **Done**: deployed (Worker `6c144b0b`); verified by the local tests only (not by exhausting the production limit) |
| B2 | Rate limit on staff sign-in | **Open**: owner decision on the limits |
| C1 | What Workers Logs record (tokens or cookies) | **Open**: needs a look in the Cloudflare dashboard |
| C2 | PostgreSQL error messages in the logs | **Open** (optional) |
| C3 | One rate-limit counter shared by trainee sign-in and application submit | **Open**: owner decision (optional) |

### Rollback
- **Site:** Cloudflare dashboard → Pages → progineer-ims → Deployments → the previous deployment (`528f0cb3…`) → *Rollback*, or redeploy that commit.
- **Worker database role:** put the owner's pooled connection string back as the secret (`npx wrangler secret put DATABASE_URL`, in `backend-workers/`; built from `ConnectionStrings:Neon` with the `-pooler` host and `sslmode=verify-full`). This is the verified path; a `wrangler rollback` is not relied on to restore an earlier secret value. The `ims_app` role and its grants are inert and stay.
- **Worker code:** `npx wrangler rollback 92b6c658-f4b8-4ce7-840e-af99c0a4ab64` (in `backend-workers/`; the release
  before the Admin role rules: **it does not enforce AD-56**, so the only Admin could lose access again), then
  `6c144b0b-bfb4-4f05-a880-a4b1c5eb491b` (before RN-1) or `aaa13c87-f4b6-45d2-b9ce-34dd74a89ba7` (before the security
  headers). All three already connect as `ims_app`, and no secret has changed since, so none can bring back the owner
  credential. The site with `6c144b0b` or older would show the full list for any chosen employee (RN-1). **Never roll back to `6625ef5c` or an earlier version**: those were deployed with the owner
  `neondb_owner` credential, and a rollback may bring back the secret values stored with that version. After any rollback,
  check the role (`/health`, and a read-only look at the Neon connections) before anything else.

None of these touches the data.

### Backups and recovery (AD-54)
- **Neon restore history window: 6 hours** (owner, 2026-11-04). Point-in-time restore is done in the Neon console.
- **Automated daily backups (PDF §9): deferred** by the owner until the remaining development is complete.
- Until then, take a manual logical backup (`pg_dump -Fc`, as the owner, read-only) before any risky production change,
  verify it by restoring it into a disposable local PostgreSQL, and keep it outside the repository. One was taken and
  verified on 2026-11-04 before the `ims_app` rollout.
- Rolling back the Worker or Pages never touches the database (above).

### Google sign-in
In Google Cloud Console → the OAuth Web client, **Authorized JavaScript origins** must contain `https://progineer-ims.pages.dev` (and `http://localhost:4200` for development). No client secret is used.

## Before the API (history)
Until the Worker was added, the Pages site served only the static app, and `/api/*` answered with the app's HTML (shown as "service not available").
