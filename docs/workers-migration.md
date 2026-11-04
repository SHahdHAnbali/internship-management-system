# API migration: ASP.NET Core → TypeScript + Hono on Cloudflare Workers

> Historical record of the port (2026-10-27). Since then the Worker is the production API and every later feature was
> built in it; current status: [requirements-progress.md](requirements-progress.md).

**Status (2026-10-27):** **deployed.** Worker `ims-api` (no public URL) behind the Pages site through a service binding; `https://progineer-ims.pages.dev/api/*` and `/health` reach it, and it uses Neon `ims_db` (pooled host, `sslmode=verify-full`). See [deployment.md](deployment.md). The ASP.NET Core API in `backend/` is unchanged and not deployed. The database schema is unchanged.

Code: [`backend-workers/`](../backend-workers/) (how to run it: [its README](../backend-workers/README.md)). Decisions: AD-38 to AD-41 in [decisions.md](decisions.md).

**Scope:** only what the C# API implements today: authentication (staff Google sign-in, trainee e-mail code/link, session, roles) and the Admin module (fields, evaluation criteria, users and roles, notification intervals), plus `/health`. Nothing from [deferred-features.md](deferred-features.md) was added.

## 1. How the parts map

| ASP.NET Core (`backend/`) | Workers (`backend-workers/src/`) |
|---|---|
| `Program.cs` pipeline: CORS → authentication → authorization → rate limiter → controllers | `app.ts`: the same order, as Hono middleware |
| Controllers (`AuthController`, `Admin/*`) | `features/auth/routes.ts`, `features/admin/routes.ts` (a route table: method, path, policy, rate limit) |
| Use cases (`Ims.Application`) | `features/auth/{staffSignIn,traineeSignIn,sessionLookup}.ts`, admin handlers |
| Domain rules (`Ims.Domain`) | `domain/*` (same error codes and messages) |
| EF Core + Npgsql, `AuditActorConnectionInterceptor` | `db.ts`: `pg` over Workers TCP sockets, plain SQL, audit actor per transaction |
| EF Core migrations | **Unchanged and still the schema owner.** The Worker never migrates |
| Cookie authentication + Data Protection | `auth/session.ts`: AES-256-GCM cookie (`SESSION_SECRET`) |
| `Google.Apis.Auth` | `auth/google.ts`: same checks, WebCrypto |
| `AddRateLimiter` (in memory, fixed window) | Workers Rate Limiting binding `TRAINEE_RATE_LIMITER` |
| `ApiExceptionHandler`, ProblemDetails, status-code pages | `http/problems.ts`, `app.onError`, `noEndpoint` |
| `[ApiController]` model binding + DataAnnotations | `http/body.ts` |
| `appsettings*.json` + user-secrets | `wrangler.jsonc` vars + Workers secrets / `.dev.vars` |
| `IEmailSender` (Log in Development, otherwise 503) | `email.ts` (same; `log` is refused outside development) |
| `/health` health check | `GET`/any method `/health`, `SELECT 1` |

## 2. Migration checklist

### Endpoints
| Endpoint | Access | Behaviour preserved | Verified by |
|---|---|---|---|
| `GET /api/auth/config` | anonymous | client id and domain only when both are set; code lifetime | `auth.test.ts`, parity |
| `POST /api/auth/staff/google` | anonymous | 400 validation; 503 `auth.google_not_configured`; 401 `auth.invalid_token` / `auth.email_not_verified`; staff domain: first sign-in creates an Employee; **other accounts: ordinary user with no role (AD-42, replaces C#'s 403 `auth.domain_not_allowed`)**; session cookie | `auth.test.ts`, parity |
| `POST /api/auth/trainee/request` | anonymous, rate-limited | 202 with no body whether or not the account exists; old codes superseded; e-mail sent before saving; 503 `email.not_configured` | `auth.test.ts`, parity |
| `POST /api/auth/trainee/verify` | anonymous, rate-limited | token wins over e-mail + code; 400 `validation.required` / `auth.invalid_code` / `validation.email`; account created on first success | `auth.test.ts`, parity |
| `GET /api/auth/me` | signed in | the caller's own account, fresh from the database | `auth.test.ts`, parity |
| `POST /api/auth/sign-out` | anonymous | 204 and the expired cookie | `auth.test.ts`, parity |
| `GET`, `POST /api/admin/fields`; `PUT /api/admin/fields/{id}` | Admin | trimmed name, null blank description, 201 + `Location`, 404, 409 duplicate name (case-insensitive) | `admin.test.ts` |
| `GET`, `POST /api/admin/evaluation-criteria`; `PUT …/{id}` | Admin | order by sort order then name; weight 0.0001–99999 | `admin.test.ts` |
| `GET /api/admin/users`; `PUT /api/admin/users/{id}/role` | Admin | staff roles only (`employee.invalid_role`); 404 checked before the role | `admin.test.ts` |
| `GET`, `PUT /api/admin/settings/notifications` | Admin | each interval 1–365 days | `admin.test.ts` |
| `GET`, `PUT /api/admin/certificate-template`; `GET`, `PUT`, `DELETE …/logo` and `…/signature` | Admin | **Workers only (AD-43)**, no C# endpoint: validated settings, version (`xmin`) check, images PNG/JPEG/WebP ≤ 512 KB | `certificate-template.test.ts` |
| `/health` (any method) | anonymous | `Healthy` 200 / `Unhealthy` 503, `text/plain`, no-cache headers | `http.test.ts`, parity, Neon check |

### Authentication, authorization and sessions
- [x] Secure by default: every endpoint needs a session unless it is marked anonymous; role policies are exact-role. 401 when anonymous, 403 for the wrong role. Same body shapes and content types.
- [x] Requests that match no endpoint: 401 when anonymous; when signed in, 404, or 405 with `Allow`. Paths are case-insensitive and ignore a trailing slash; `{id:guid}` accepts the N, D, B and P formats.
- [x] The account and its role are re-read from PostgreSQL on every request. A role change applies to the current session and re-issues the cookie. A cookie for a missing account is cleared.
- [x] Cookie `ims.session`: `path=/; samesite=strict; httponly`, plus `secure` outside development; a browser-session cookie; 8-hour sliding expiry, renewed after half; `Cache-Control: no-cache,no-store` whenever it is set. **Changed by AD-44**: persistent cookie (`expires`/`max-age`), 7-day idle and 30-day absolute expiry, server-side `user_sessions` with revocation on sign-out.
- [x] Google ID token: RS256 with Google's keys, issuer `accounts.google.com` or `https://accounts.google.com`, every audience equal to the client id, `exp` with no tolerance, `iat` with 30 s tolerance (Google.Apis.Auth defaults). Verified e-mail, `hd` claim equal to the domain, and an `@domain` address.
- [x] Trainee code and link: 6-digit uniform code and 32-byte link token, SHA-256 **upper-case hex** hashes (code hash bound to the record id). 15 minutes, single use, superseded by a newer request, locked after 5 wrong codes, constant-time comparison. Same e-mail text (Arabic and English).
- [x] Rate limit: 10 requests per minute per client IP, shared by the two trainee endpoints; body `{status, traceId}`.
- [x] CORS: configured origins only, with credentials; preflight answered with 204.

### Validation
- [x] JSON content types only (415 otherwise); case-insensitive property names; .NET defaults for missing values; numbers accepted as strings; `null` and an empty body give the same 400.
- [x] DataAnnotations messages and keys (`The Name field is required.`, max-length and range messages), keyed by C# property name.
- [x] Domain messages and codes: `validation.required`, `validation.too_long`, `validation.email`, `validation.range`, `employee.invalid_role`.
- [x] E-mail validation is identical to .NET `MailAddress` (ported reader by reader), including .NET white-space and lower-casing rules. Checked on 5,115 cases produced by the real C# code (`test/fixtures/email-corpus.json`; 32,839 cases checked during development).

### Database
- [x] No schema change. The same tables, constraints, indexes and triggers; `test/schema.sql` is generated from the EF Core migrations, and the tests fail if it is out of date.
- [x] Every write runs in one transaction with the audit actor (`Anonymous`, `Staff` + id, `Trainee` + id), like one EF `SaveChanges`. **The audit trail is identical** (see §3).
- [x] No deletes anywhere; the no-delete and append-only triggers are untouched (tested).
- [x] Optimistic concurrency on `xmin` for every update EF guarded (fields, criteria, employees, sign-in codes) → 409 `conflict.concurrent_update`; unique violations → 409 `conflict.duplicate`.
- [x] Updates that change nothing write nothing (no audit row, `xmin` unchanged), as with EF.
- [x] Ids are UUID v7 generated by the application; times come from an injectable clock.

## 3. Verification results

| Check | Result |
|---|---|
| Automated tests in the Workers runtime (`npm test`: workerd via `@cloudflare/vitest-plugin`, disposable PostgreSQL 18.6 in Docker) | **96 passed**: domain rules, the e-mail corpus, auth and sessions, Admin, database integrity, HTTP contract, rate limit. Every C# integration and unit test has an equivalent |
| `tsc` strict type check | passes |
| Black-box parity: the same 80 scripted requests to the C# API and to the Worker under `wrangler dev`, each on its own fresh database | **76/80 identical** (status, headers, cookie attributes, bodies). The 4 others differ only in the free-text wording of malformed-JSON and wrong-type messages |
| Audit trail after the parity run | **identical**: 15 rows each, same tables, operations, actors, changed columns, old values and transaction grouping |
| Cross-API compatibility on one database | a code issued by C# verifies in the Worker, and a code and a link issued by the Worker verify in C# |
| React frontend (unchanged) against the Worker | browser run: sign-in page, code e-mail, verify, `/trainee` shows the account, role guards, 403 from the Admin API, sign-out → 401, Arabic/English, no horizontal scroll at 390 px |
| Neon (read-only) | in production mode with `sslmode=verify-full`, the Workers runtime connects to Neon over TLS: `/health` → Healthy. Session forced read-only; Neon row counts unchanged (12 audit rows, 4 trainees, 4 codes) |
| Bundle | 316 KiB, **71 KiB gzipped** (Free plan limit: 3 MB) |
| CPU (measured in Node with the same WebCrypto operations; workerd does not report CPU locally) | per request: session cookie < 0.03 ms, Google token check < 0.06 ms, database login (SCRAM, 4096 PBKDF2 iterations) ≈ 0.5 ms. Well below the 10 ms Free limit; **confirm with Workers analytics after the first deployment** |

Not covered automatically: a real Google account (needs the client id) and the Admin pages in a browser, which need a real Google sign-in. The Admin API is covered by the integration tests, which use the frontend's JSON shapes.

## 4. Differences and limitations (not silently changed)

| Area | Difference | Why / impact |
|---|---|---|
| Google accounts outside the staff domain | C# answers 403 `auth.domain_not_allowed`. The Worker signs them in as ordinary users with `role: null`, no record and no permissions (owner decision AD-42) | Intentional; the C# API was not changed |
| Missing `role` in `PUT /api/admin/users/{id}/role` | C# binds a missing role to `default(UserRole)` = **Admin** and promotes the user. The Worker answers 400 `{"Role": ["The Role field is required."]}` | A missing value should never grant Admin. Only reachable by an Admin. **Fix the C# API the same way** (make `Role` required) if both stay in use |
| E-mail provider `log` | Ignored outside `ENVIRONMENT=development` (503 instead) | Logging sign-in codes in production would let anyone with log access sign in as a trainee |
| Database TLS | Production refuses a `DATABASE_URL` without `sslmode=verify-full` (unless Hyperdrive is bound) | Hardening |
| **SCRAM channel binding** | The Npgsql string requires channel binding; `pg` on Workers cannot do it (no access to the server certificate) | TLS with full certificate and host-name verification still applies. Remove `channel_binding=require` from the URL. Hyperdrive is the alternative |
| Sessions | C# cookies (Data Protection) are not readable by the Worker, and the reverse | Everyone signs in once after the switch. Sign-in codes are compatible both ways |
| Rate limiting | The Workers binding is per Cloudflare location and approximate; the limit is set in `wrangler.jsonc` (deploy time), not in app settings | Same purpose (abuse protection). Period must be 10 or 60 s |
| Malformed-JSON messages | Same keys and status, different wording (no .NET byte positions) | Not used by the client |
| Rare binding edge cases | `1.0` for an integer is accepted (JSON numbers are not distinguishable in JS); enum flag strings like `"Admin, HR"` are rejected; GUID format `X` is not accepted in URLs | No client sends these |
| `Vary: Origin` | Sent only with several allowed origins, as ASP.NET does | Same |
| OpenAPI document (`/openapi/v1.json`, Development only) | Not reproduced | Development tooling only |
| `UseHttpsRedirection` | Not needed: Cloudflare serves HTTPS (turn on "Always Use HTTPS" for the zone) | — |
| Weight precision | A weight with more than 4 decimals is echoed as sent on create/update and stored rounded (`numeric(9,4)`), exactly like C# | Same |
| Latency | One new TLS connection to Neon per request (≈1.2 s from this machine to us-east-2) | Expect much less from Cloudflare's network; use Neon's pooled host or Hyperdrive (supported: bind `HYPERDRIVE`) |

## 5. Configuration (Cloudflare Workers + Neon)

| Name | Kind | Value |
|---|---|---|
| `DATABASE_URL` | **secret** | Neon **pooled** host (`…-pooler…neon.tech`), `postgres://<role>:<password>@<host>/ims_db?sslmode=verify-full`, no `channel_binding` |
| `SESSION_SECRET` | **secret** | ≥ 32 random characters: `openssl rand -base64 48` |
| `SESSION_SECRET_PREVIOUS` | secret, optional | the old secret during a rotation |
| `ENVIRONMENT` | var | `production` (default in `wrangler.jsonc`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_HOSTED_DOMAIN` | var | as in [authentication.md](authentication.md) |
| `TRAINEE_SIGN_IN_LINK_BASE_URL` | var | the public web URL (e.g. `https://progineer-ims.pages.dev`) |
| `TRAINEE_CODE_LIFETIME_MINUTES`, `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_LIFETIME_MINUTES` | var | 15, 10080 (7 days), 43200 (30 days) (AD-44) |
| `CORS_ALLOWED_ORIGINS` | var | empty when the API is served on the site's own origin (recommended) |
| `EMAIL_PROVIDER` | var | empty until a provider is added (trainee codes then answer 503, as today) |
| `TRAINEE_RATE_LIMITER` | binding | in `wrangler.jsonc` (10 / 60 s) |
| `HYPERDRIVE` | binding, optional | replaces `DATABASE_URL` |

Secrets are set with `npx wrangler secret put <NAME>` and are never in Git. Local development uses `backend-workers/.dev.vars` (git-ignored; template `.dev.vars.example`).

**Neon role:** the application needs only `SELECT, INSERT, UPDATE` on the tables (and the sequences/functions the triggers use). Consider a dedicated role instead of the owner role, so a code bug cannot drop or alter tables. This is a database change, so it is not done here.

## 6. Before deploying (decisions for the owner)
1. **Same origin.** The cookie is `SameSite=Strict` and the frontend calls `/api`. Serve the Worker on the Pages site's origin: a Pages Function or `_worker.js` that forwards `/api/*` to the Worker through a service binding, or one Worker serving both the static assets and the API. This changes the frontend deployment, so it is not done yet.
2. Set the secrets and vars above. Enable a route (`workers_dev` and `preview_urls` are off).
3. Decide what happens to the 4 test trainees on Neon (see the earlier inspection).
4. Choose the e-mail provider (Q10): without it, trainee sign-in answers 503 in production, as the C# API does.
5. After the first deploy, check CPU time and errors in Workers analytics and logs.
6. Decide whether `backend/` stays as a second implementation or is retired. Until then, schema changes still go through its EF Core migrations, followed by `npm run schema:generate` in `backend-workers/`.
