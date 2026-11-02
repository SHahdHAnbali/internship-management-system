# IMS: Trainee Management System

نظام إدارة المتدربين: tracks every trainee from application to certificate and keeps a permanent record of each training.

| Part | Stack | Path |
|---|---|---|
| API | ASP.NET Core 10 Web API, EF Core, PostgreSQL | [backend/](backend/) |
| API (Workers port, not deployed) | TypeScript + Hono on Cloudflare Workers, same database and contracts | [backend-workers/](backend-workers/) |
| Web | React 19 + TypeScript + Vite + Tailwind (RTL/LTR), hosted on Cloudflare Pages | [frontend/](frontend/) |
| Docs | Requirements, architecture, decisions, roadmap | [docs/](docs/) |

## Prerequisites
- .NET SDK 10 (pinned in `global.json`)
- Node 22.22+ (`nvm use`, reads `.nvmrc`)
- Docker Desktop (local PostgreSQL and integration tests)

## Local database
```bash
cp .env.example .env            # set POSTGRES_PASSWORD (never commit .env)
docker compose up -d            # PostgreSQL 18.6 on localhost:5434, data in volume ims-db-data
dotnet tool restore             # installs dotnet-ef from dotnet-tools.json
dotnet user-secrets set "ConnectionStrings:Database" \
  "Host=localhost;Port=5434;Database=ims_dev;Username=ims;Password=<POSTGRES_PASSWORD>" \
  --project backend/src/Ims.Api
```

## Run locally
```bash
cd backend && dotnet run --project src/Ims.Api      # API on http://localhost:5106, /health
cd frontend && npm install && npm start             # SPA on http://localhost:4200 (proxies /api)
```

Admin pages without sign-in (local mock data, dev only): `cd frontend && npm run start:preview`, then open http://localhost:4200/admin. See [docs/admin-preview.md](docs/admin-preview.md).

## Test
```bash
cd backend && dotnet test                           # needs Docker running
cd frontend && npm test -- --run
```

## Documentation
- [Requirements analysis](docs/requirements-analysis.md)
- [Architecture](docs/architecture.md)
- [Domain model](docs/domain-model.md)
- [Decisions, assumptions & open questions](docs/decisions.md)
- [Roadmap](docs/roadmap.md)
- [Deferred features](docs/deferred-features.md): features waiting for other modules
- [Requirements progress](docs/requirements-progress.md): every PDF requirement and its implementation status
- [Authentication](docs/authentication.md): sign-in flows, roles, and the configuration you must provide
- [Deployment](docs/deployment.md): Cloudflare Pages (frontend) and its limitations
- [Workers migration](docs/workers-migration.md): the TypeScript/Hono API port, checklist, test results, configuration
- [Certificate template](docs/certificate-template.md): the Admin certificate editor, its fonts and PDF-rendering requirements
- [CLAUDE.md](CLAUDE.md): coding standards
