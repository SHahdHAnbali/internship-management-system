# CLAUDE.md: IMS (Internship / Trainee Management System)

Instructions for AI assistants and developers working in this repository.

## Read first
- `docs/requirements-analysis.md`: what the system must do (from the requirements PDF, the source of truth).
- `docs/architecture.md`: layers, dependency rules, folder layout.
- `docs/domain-model.md`: entities, relationships, cross-cutting rules.
- `docs/decisions.md`: decisions taken, assumptions, **open questions**, and dependencies to add.
- `docs/roadmap.md`: the incremental plan. Update its checkboxes when a slice ships.
- `docs/deferred-features.md`: PDF features blocked by modules that don't exist yet. When a module ships, update the rows that depend on it.
- `docs/design-system.md`: the visual design system. Follow it for every page.
- `docs/authentication.md`: sign-in flows, session, role guards, and required external configuration.

**Never invent business rules.** If the PDF and docs do not answer something, add it to `docs/decisions.md` §D and ask, rather than guessing in code.

## Repository layout
```
backend/    ASP.NET Core 10 solution (Ims.slnx): src/{Ims.Domain, Ims.Application, Ims.Infrastructure, Ims.Api}, tests/
frontend/   React 19 + TypeScript + Vite SPA (ims-web), deployed to Cloudflare Pages
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
npm run start:preview                      # Admin Preview Mode: /admin with in-browser mock data, no sign-in (docs/admin-preview.md)
npm run build
npm test -- --run                          # Vitest + React Testing Library
npm run lint                               # oxlint
npm run deploy                             # Cloudflare Pages (docs/deployment.md)

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
- **Never hard-delete.** Model reject, withdraw, cancel and revoke as status changes with a reason. PostgreSQL triggers reject DELETE/TRUNCATE on every table, and `PreventDeleteInterceptor` fails fast in EF.
- **Every write is audited automatically by database triggers** (`audit_logs`, actor from `ICurrentUser`). Never write audit rows in code. **Every new table's migration must run `SELECT ims_protect_table('<table>');`**.
- **Trainee isolation**: every query reachable by a trainee filters by the current trainee's id. Add an integration test for it.
- IDs: `Guid.CreateVersion7()`. Times: UTC `DateTimeOffset`. Assignment dates: `DateOnly`. Use the injected `TimeProvider`, never `DateTime.Now`.
- Package versions live only in `backend/Directory.Packages.props`. Shared build settings live in `backend/Directory.Build.props`. Warnings are errors, so fix them; do not suppress them.
- Secrets never go in `appsettings*.json` or any tracked file. Use `dotnet user-secrets` locally. `.env` is git-ignored, while `.env.example` is tracked and holds placeholders only.
- **Auth is secure by default**: the fallback policy requires a signed-in user. Mark public endpoints `[AllowAnonymous]` deliberately, and protect role endpoints with `[Authorize(Policy = AuthPolicies.Hr)]` etc. (`Ims.Api/Auth`). The signed-in user's id is the `NameIdentifier` claim (`ICurrentUser.UserId`). **Trainee endpoints must always filter by it** and never by an id taken from the request. Frontend areas use `roleGuard(...)` in `app.routes.ts`.
- Validation: DataAnnotations on request DTOs (automatic 400 `ProblemDetails`), plus business rules in Domain methods. Logging: inject `ILogger<T>` and use message templates (`"Accepted {ApplicationId}"`), never string interpolation.
- Tests: xUnit v3, names like `Method_scenario_expectation` (CA1707 is off in `tests/`). Integration tests use `IClassFixture<ImsApiFactory>` (real, migrated PostgreSQL via Testcontainers). Use `factory.CreateClient("Admin")` to call the API as a role through the test-only `TestAuthHandler`. Pass `TestContext.Current.CancellationToken` to async calls.
- Request DTOs are records: put DataAnnotations on the constructor parameters (`[Required] string Name`), **not** `[property: …]`, or MVC throws at runtime.
- Role codes are exactly `Admin`, `HR`, `Trainee`, `Employee` (`roles` table, `UserRole` enum, `AuthRoles`).
- Naming: PascalCase types and members, `_camelCase` private fields, async methods end with `Async` and accept a `CancellationToken`.

## Frontend rules
- React function components and hooks only, TypeScript `strict`. Shared state through small contexts (`auth/context.ts`, `i18n/context.ts`, `components/toastContext.ts`); keep a context and its hook in a `.ts` file separate from the provider component (fast refresh).
- Code lives in `src/features/<area>/` (`public`, `admin`, `areas`, and later `trainee`, `employee`, `hr`). App-wide pieces are in `src/auth`, `src/i18n`, `src/lib` (API client), `src/preview`. Reusable presentational components are in `src/components`. Features must not import from other features.
- Routes are declared in `src/routes.tsx` with route-level `lazy` code-splitting. Every role area is wrapped in `<RequireRole role="…">` (`src/auth/guards.tsx`). The API enforces the same rules; guards are navigation only.
- HTTP goes through `apiRequest` (`src/lib/api.ts`) and per-feature API modules (`features/admin/adminApi.ts`). The base URL is `VITE_API_BASE_URL` or `/api`. Never hard-code hosts.
- **Bilingual RTL/LTR**: default `ar`/`rtl`. Use logical properties and utilities (`ms-*`, `pe-*`, `start-*`, `text-start`, `margin-inline-start`) and never `left`/`right` (`ml-*`, `mr-*`, `left-*`) for layout.
- **All user-facing text goes through `t()`** from `useI18n()`. Add every key to both `public/i18n/ar.json` and `public/i18n/en.json` (`{{param}}` placeholders). Change language only through `setLanguage()`, which also sets `<html lang dir>`.
- No UI component library: use native elements with the design-system classes (`ims-btn-primary|outline|text`, `ims-input`, `ims-label`, `ims-table`, `ims-tab`, `ims-card`, `ims-state`, …) and the shared components (`Dialog` on native `<dialog>`, `Switch`, `Toast`, `LanguageSwitch`). **Follow `docs/design-system.md`**: Tailwind utilities with the IMS theme (`text-heading`, `border-border`, `rounded-card`, `max-w-content`, `px-gutter`, …). Keep SCSS for tokens (`src/styles/_tokens.scss`) and base styles only. Never hard-code colours, radii or spacing.
- Accessibility: every input has a `<label>`, errors are linked with `aria-describedby` and `aria-invalid`, toggles are `role="switch"`, and disabled-but-visible actions use `aria-disabled`.
- Tests: Vitest + React Testing Library (`src/**/*.test.tsx`). Use `renderPage` / `renderRoutes` / `mockFetch` from `src/test/render.tsx`, and query by role and label.
- Format with Prettier (`frontend/.prettierrc`), lint with oxlint (`npm run lint`, keep it at zero findings).

## Domain vocabulary
Use the code names from `docs/requirements-analysis.md` §2: `Trainee`, `Employee` (+ `StaffRole`), `Field`, `TrainingApplication`, `MentorRequest`, `Assignment`, `ProgressNote`, `EvaluationCriterion`, `Evaluation`, `Certificate`, `ContactLog`, `Notification`, `AuditLog` (`AuditLogEntry`), plus `Role`/`UserRole` and `NotificationSettings`.

## Workflow
- Build one vertical slice at a time, following `docs/roadmap.md`. Each slice includes tests (domain unit tests for state rules, and integration tests for endpoints and role access).
- Before finishing: `dotnet build && dotnet test` in `backend/`, and `npm run build && npm test -- --run && npm run lint` in `frontend/`.
- Do not add libraries outside those listed in `docs/decisions.md` §E without recording the reason there.
