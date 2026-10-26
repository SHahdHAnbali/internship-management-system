# IMS: Trainee Management System

نظام إدارة المتدربين: tracks every trainee from application to certificate and keeps a permanent record of each training.

| Part | Stack | Path |
|---|---|---|
| API | ASP.NET Core 10 Web API, EF Core, PostgreSQL | [backend/](backend/) |
| Web | Angular 22 (standalone, RTL/LTR) | [frontend/](frontend/) |
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

## Test
```bash
cd backend && dotnet test                           # needs Docker running
cd frontend && npm test -- --watch=false
```

## Documentation
- [Requirements analysis](docs/requirements-analysis.md)
- [Architecture](docs/architecture.md)
- [Domain model](docs/domain-model.md)
- [Decisions, assumptions & open questions](docs/decisions.md)
- [Roadmap](docs/roadmap.md)
- [Deferred features](docs/deferred-features.md): features waiting for other modules
- [CLAUDE.md](CLAUDE.md): coding standards
