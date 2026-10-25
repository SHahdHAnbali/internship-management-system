# CLAUDE.md: IMS (Internship / Trainee Management System)

Instructions for AI assistants and developers working in this repository.

## Read first
- `docs/requirements-analysis.md`: what the system must do (from the requirements PDF, the source of truth).
- `docs/architecture.md`: layers, dependency rules, folder layout.
- `docs/domain-model.md`: entities, relationships, cross-cutting rules.
- `docs/decisions.md`: decisions taken, assumptions, **open questions**, and dependencies to add.
- `docs/roadmap.md`: the incremental plan. Update its checkboxes when a slice ships.

**Never invent business rules.** If the PDF and docs do not answer something, add it to `docs/decisions.md` §D and ask, rather than guessing in code.

## Repository layout
```
backend/    ASP.NET Core 10 solution (Ims.slnx): src/{Ims.Domain, Ims.Application, Ims.Infrastructure, Ims.Api}, tests/
frontend/   Angular 22 SPA (ims-web)
docs/       architecture & requirements docs
```

## Commands
```bash
# One-time setup (repo root): Docker Desktop must be running
cp .env.example .env                       # then set POSTGRES_PASSWORD
docker compose up -d                       # PostgreSQL 18.6 on localhost:5434
dotnet tool restore                        # dotnet-ef
dotnet user-secrets set "ConnectionStrings:Database" \
  "Host=localhost;Port=5434;Database=ims_dev;Username=ims;Password=<from .env>" --project backend/src/Ims.Api

# Backend (from backend/)
dotnet build
dotnet test                                # xUnit v3 on Microsoft.Testing.Platform; integration tests need Docker
dotnet run --project src/Ims.Api          # http://localhost:5106, /health (includes DB), /openapi/v1.json (dev)

# Frontend (from frontend/), requires Node 22: `nvm use` at the repo root
npm start                                  # http://localhost:4200, proxies /api → :5106
npm run build
npm test -- --watch=false                  # Vitest

# Migrations (from backend/)
dotnet ef migrations add <Name> -p src/Ims.Infrastructure -s src/Ims.Api -o Persistence/Migrations
dotnet ef database update -p src/Ims.Infrastructure -s src/Ims.Api
```

## Backend rules
- **Dependency direction**: Api → Application → Domain; Infrastructure → Application; Api → Infrastructure (composition only). Domain references nothing. Application never references Infrastructure, Npgsql, vendor SDKs or HTTP types.
- **Organise by feature, not by technical type.** A new feature adds `Ims.Domain/<Area>/`, `Ims.Application/<Feature>/`, EF configuration in `Ims.Infrastructure/Persistence/Configurations/`, and one controller in `Ims.Api/Controllers/`.
- Use cases are plain classes (e.g. `SubmitApplication`) registered in `Ims.Application/DependencyInjection.cs`. No MediatR, no generic repositories. Use `IAppDbContext` directly.
- Controllers are thin: bind input → call a use case → map the result to an HTTP response. Routes start with `api/`. Errors are returned as `ProblemDetails`.
- Domain entities protect their invariants. State changes go through methods (`application.Accept(...)`, `assignment.Transfer(...)`) that validate the current status, not through public setters.
- **Never hard-delete.** Model reject, withdraw, cancel and revoke as status changes with a reason. The audit interceptor must reject `EntityState.Deleted`.
- **Every write is audited automatically** by the interceptor. Do not hand-write audit rows in features.
- **Trainee isolation**: every query reachable by a trainee filters by the current trainee's id. Add an integration test for it.
- IDs: `Guid.CreateVersion7()`. Times: UTC `DateTimeOffset`. Assignment dates: `DateOnly`. Use `TimeProvider`/`IClock`, never `DateTime.Now`.
- Package versions live only in `backend/Directory.Packages.props`. Shared build settings live in `backend/Directory.Build.props`. Warnings are errors, so fix them; do not suppress them.
- Secrets never go in `appsettings*.json` or any tracked file. Use `dotnet user-secrets` locally. `.env` is git-ignored, while `.env.example` is tracked and holds placeholders only.
- **Auth is secure by default**: the fallback policy requires a signed-in user. Mark public endpoints `[AllowAnonymous]` deliberately, and protect role endpoints with `[Authorize(Policy = AuthPolicies.Hr)]` etc. (`Ims.Api/Auth`).
- Validation: DataAnnotations on request DTOs (automatic 400 `ProblemDetails`), plus business rules in Domain methods. Logging: inject `ILogger<T>` and use message templates (`"Accepted {ApplicationId}"`), never string interpolation.
- Tests: xUnit v3, names like `Method_scenario_expectation` (CA1707 is off in `tests/`). Integration tests use `IClassFixture<ImsApiFactory>` (real PostgreSQL via Testcontainers). Pass `TestContext.Current.CancellationToken` to async calls.
- Naming: PascalCase types and members, `_camelCase` private fields, async methods end with `Async` and accept a `CancellationToken`.

## Frontend rules
- Standalone components only (no NgModules). Use `inject()`, signals for state, `input()`/`output()`, and `@if`/`@for` control flow.
- Code lives in `src/app/features/<area>/` (`public`, `trainee`, `employee`, `hr`, `admin`). App-wide singletons go in `core/`. Stateless reusable UI goes in `shared/`. Features must not import from other features.
- Each area is lazy-loaded from `app.routes.ts` and protected by a role guard (once auth exists). Keep `features/public` minimal: it is the public certificate page.
- HTTP calls go through feature data services using `environment.apiBaseUrl`. Never hard-code hosts.
- **Bilingual RTL/LTR**: default `ar`/`rtl`. Use CSS logical properties (`margin-inline-start`, `inset-inline-end`) and never `left`/`right` for layout.
- **All user-facing text goes through Transloco** (`transloco` pipe/directive). Add every key to both `public/i18n/ar.json` and `public/i18n/en.json`. Change language only through `core/i18n/LanguageService.use()`, never `TranslocoService.setActiveLang` directly, so direction stays in sync.
- UI components come from Angular Material only. Do not add another UI kit. Theme tokens (`var(--mat-sys-*)`) are preferred over hard-coded colours. Responsive by default: fluid layouts, plus CDK `BreakpointObserver` when needed.
- File naming follows the Angular CLI (`foo.ts`, `foo.html`, `foo.scss`, `foo.spec.ts`). Generate with `npx ng generate …`.
- Format with Prettier (`frontend/.prettierrc`).

## Domain vocabulary
Use the code names from `docs/requirements-analysis.md` §2: `Trainee`, `Employee` (+ `StaffRole`), `Field`, `TrainingApplication`, `MentorRequest`, `Assignment`, `ProgressNote`, `EvaluationCriterion`, `Evaluation`, `Certificate`, `ContactLog`, `Notification`, `AuditLog`.

## Workflow
- Build one vertical slice at a time, following `docs/roadmap.md`. Each slice includes tests (domain unit tests for state rules, and integration tests for endpoints and role access).
- Before finishing: `dotnet build && dotnet test` in `backend/`, and `npm run build && npm test -- --watch=false` in `frontend/`.
- Do not add libraries outside those listed in `docs/decisions.md` §E without recording the reason there.
- `frontend/package.json` has `overrides.vite` (AD-20). Remove it once `@angular/build` ships a patched Vite.
