# IMS API on Cloudflare Workers

TypeScript + [Hono](https://hono.dev) port of the ASP.NET Core API in [`../backend`](../backend), for Cloudflare Workers with the existing Neon PostgreSQL. It has the same endpoints, JSON contracts, sign-in flows, roles and database. **Not deployed yet.**

The mapping, test results and known differences are in [docs/workers-migration.md](../docs/workers-migration.md).

```
src/
  index.ts            Worker entry
  app.ts              pipeline: CORS → session → authorization → rate limit → route; error mapping
  config.ts           vars, secrets and bindings, validated
  db.ts               pg connection per request; audited transactions; xmin concurrency
  auth/               session cookie (AES-GCM), Google ID token verification
  http/               route table, JSON binding + validation, ProblemDetails
  domain/             business rules (same codes/messages as Ims.Domain)
  features/auth/      /api/auth/*
  features/admin/     /api/admin/*
test/                 Vitest inside workerd, disposable PostgreSQL from test/schema.sql
```

## Requirements
- Node 22 (`nvm use` at the repo root) and Docker Desktop (for tests).
- The database schema comes from the EF Core migrations in `../backend`. This project never migrates.

## Run locally
```bash
cd backend-workers
npm install
cp .dev.vars.example .dev.vars      # fill in DATABASE_URL (local Docker DB) and SESSION_SECRET; git-ignored
npm run dev -- --port 5106          # wrangler dev (workerd) on the port the frontend proxy uses
cd ../frontend && npm start         # http://localhost:4200, /api → :5106
```
With `EMAIL_PROVIDER=log`, trainee sign-in codes are printed in the `wrangler dev` console (development only). Stop the ASP.NET API first if it uses port 5106.

## Test
```bash
npm test -- --run        # starts a throwaway postgres:18.6 container, runs all tests in workerd, removes it
npm run typecheck        # wrangler types + tsc (strict)
```
Set `TEST_DATABASE_URL` to use an existing empty, disposable database instead of Docker. After adding an EF Core migration, run `npm run schema:generate` (needs the .NET SDK); the tests fail while `test/schema.sql` is out of date.

## Configure and deploy (not done yet)
Settings are listed in [docs/workers-migration.md §5](../docs/workers-migration.md#5-configuration-cloudflare-workers--neon). In short:
```bash
npx wrangler login
npx wrangler secret put DATABASE_URL       # Neon pooled host, sslmode=verify-full, no channel_binding
npx wrangler secret put SESSION_SECRET     # openssl rand -base64 48
# set GOOGLE_*, TRAINEE_SIGN_IN_LINK_BASE_URL in wrangler.jsonc "vars", choose a route, then:
npx wrangler deploy
```
Read §6 of the migration document first: the API must be served on the web app's origin, because the session cookie is `SameSite=Strict`.
