# Architecture

## 1. Summary

**A modular monolith**: one ASP.NET Core Web API, one PostgreSQL database and one Angular SPA, deployed as a single cloud application.

- **Backend**: four projects with Clean Architecture dependency rules. Code is organised by **feature (vertical slices)** inside the Application layer.
- **Frontend**: a standalone-component Angular app with one **lazy-loaded area per role**, plus a lightweight public certificate route.

```
             ┌──────────────── Angular SPA (frontend/) ───────────────┐
             │  /c/:code (public) │ /trainee │ /employee │ /hr │ /admin │
             └───────────────────────────────┬──────────────────────────┘
                                             │ HTTPS  /api/*
┌────────────────────────── ASP.NET Core (backend/) ─────────────────────────┐
│ Ims.Api            controllers, auth schemes, policies, ProblemDetails, DI │
│   │                                                                        │
│   ├─► Ims.Application   feature use cases, DTOs, ports (interfaces)        │
│   │        │                                                               │
│   │        └─► Ims.Domain   entities, enums, state-transition rules        │
│   │                                                                        │
│   └─► Ims.Infrastructure  EF Core/Npgsql, audit interceptor, email,       │
│            (implements Application ports)  file storage, PDF/QR, jobs      │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        ▼
                                   PostgreSQL
```

## 2. Why this architecture

| Force from the requirements | Consequence |
|---|---|
| Small team: one full-stack developer, about 11 weeks (PDF §10) | **No microservices**, no message bus, no CQRS framework. One deployable unit. |
| Several external integrations with **undecided vendors**: S3 vs Azure Blob, SendGrid vs SES, Azure vs AWS, Hangfire "or similar" | Keep them behind small interfaces in `Ims.Application` and implement them in `Ims.Infrastructure`. Changing vendor touches one project. |
| Real business rules in state transitions (application → mentor request → assignment → evaluation → certificate, with transfer, extend, end early, withdraw, revoke) | A persistence-free `Ims.Domain` holds those rules, so they can be unit-tested without a database. |
| "Audit every change" and "never delete" apply to **every** table | Enforced once, centrally, by **PostgreSQL triggers** created in the first migration (`ims_protect_table`). EF only passes the actor (`AuditActorConnectionInterceptor`) and fails fast on deletes (`PreventDeleteInterceptor`). Triggers also cover bulk updates and raw SQL. |
| Four roles with different views of the same data | Role-based authorization policies in Api. Per-role lazy areas in the SPA. Queries scoped per user in Application. |
| Phase 1 must be usable alone, then phases 2 and 3 add to it | Vertical feature folders let each feature ship as a self-contained increment. |

**Deliberately avoided** (overengineering for this scope):
- Generic repository / unit-of-work wrappers. EF Core's `DbContext` already provides both. The Application layer uses an `IAppDbContext` abstraction that exposes `DbSet`s.
- A mediator library (MediatR, etc.). Use cases are plain injectable classes called by controllers.
- Separate read/write models, event sourcing, or a domain-event bus. The audit log covers the history requirement.
- Separate Angular libraries or a monorepo tool. One Angular application is enough.

## 3. Backend

### Projects & dependency rule

| Project | References | Contains | Must NOT contain |
|---|---|---|---|
| `Ims.Domain` | — | Entities, enums, value objects, domain rules (state transitions with guard clauses) | EF Core, ASP.NET, any I/O |
| `Ims.Application` | Domain | Feature use cases, request/response DTOs, validation, authorization-aware query scoping, **ports** (`IAppDbContext`, `IEmailSender`, `IFileStorage`, `ICertificateRenderer`, `ICurrentUser`, `IClock`) | HTTP types, provider-specific code (Npgsql, SendGrid SDK, …) |
| `Ims.Infrastructure` | Application | `AppDbContext`, entity configurations, migrations, audit interceptor, adapter implementations of the ports, scheduled jobs | Business rules |
| `Ims.Api` | Application, Infrastructure | Controllers, authentication (Google + passwordless trainee), authorization policies, middleware, composition root (`Program.cs`) | Business logic, direct `DbContext` usage in controllers |

`Ims.Application` and `Ims.Infrastructure` use a `FrameworkReference` to `Microsoft.AspNetCore.App`. This gives them DI, options, logging and configuration abstractions without NuGet packages. The Application layer must still avoid HTTP types.

### Target folder layout (grows feature by feature)

```
backend/src/
  Ims.Domain/
    Common/                 Entity base, shared value objects
    Trainees/ Staff/ Fields/ Applications/ Mentoring/ Assignments/
    Evaluations/ Certificates/ Notifications/ Auditing/
  Ims.Application/
    Common/                 ports (interfaces), paging, errors/Result, ICurrentUser
    <Feature>/              e.g. Applications/SubmitApplication.cs, Applications/ApplicationDto.cs
    DependencyInjection.cs
  Ims.Infrastructure/
    Persistence/            AppDbContext, Configurations/, Migrations/, Interceptors/AuditInterceptor.cs
    Email/ Storage/ Documents/ (PDF, QR, Excel) Jobs/ Identity/
    DependencyInjection.cs
  Ims.Api/
    Controllers/            one controller per feature area, routes under /api/...
    Auth/                   schemes, policies (Trainee, Employee, Hr, Admin)
    Program.cs
backend/tests/
  Ims.UnitTests/            Domain rules + Application use cases
  Ims.IntegrationTests/     API end-to-end against a real PostgreSQL
```

### Cross-cutting conventions

- **API surface**: REST under `/api/...`, JSON, errors as RFC 7807 `ProblemDetails`, OpenAPI document at `/openapi/v1.json` in development, health check at `/health`.
- **Auth model**: two identity types, *staff* (Google, domain-restricted, role in the `Employee` table) and *trainee* (email one-time link or code, 15-minute validity). After verifying either one, the API issues an HttpOnly session cookie (`ims.session`). Role policies `Trainee`, `Employee`, `Hr` and `Admin` are in `Ims.Api/Auth`. A fallback policy requires authentication everywhere except `[AllowAnonymous]` endpoints (`/health`, OpenAPI). The cookie scheme and policies are already wired. Sign-in endpoints are not implemented yet.
- **Audit and no-delete**: database triggers write `audit_logs` (actor, operation, table, row key, changed columns before/after, transaction id, time) in the same transaction, reject DELETE/TRUNCATE on every table, and keep `audit_logs` append-only.
- **Time**: store `timestamptz` in UTC. Assignment start and end are `date` (`DateOnly`). Inject `IClock` / `TimeProvider` for testability.
- **IDs**: `Guid.CreateVersion7()` (time-ordered, index-friendly in PostgreSQL).
- **Configuration**: `appsettings*.json` contains no secrets. Local secrets go in `dotnet user-secrets` (`UserSecretsId=ims-api-dev`) and production secrets in the host's secret store. The connection string `ConnectionStrings:Database` is resolved when the `DbContext` is first built and fails with a clear message if missing.
- **Logging**: built-in `ILogger`. JSON console output outside Development, single-line text in Development.
- **Health**: `/health` includes a database connectivity check (`DatabaseHealthCheck`).
- **Build quality**: `TreatWarningsAsErrors`, latest recommended analyzers, and Central Package Management (`Directory.Packages.props`).

## 4. Frontend

```
frontend/src/app/
  core/       singletons: auth service, HTTP interceptors (API base URL, auth, errors),
              route guards per role, i18n/direction service, app shell/layout
  shared/     reusable presentational components, pipes, directives (no services with state)
  features/
    public/   /c/:code  certificate verification (no auth, minimal bundle)
    trainee/  apply, status board, my certificate
    employee/ available trainees, mentor requests, my trainees, progress notes, evaluation
    hr/       applications inbox, contact log, mentor requests, running trainings, reports
    admin/    fields, evaluation criteria, users and roles, settings, templates
  app.routes.ts   lazy loadChildren per feature area
  app.config.ts   provideRouter, provideHttpClient(withFetch())
```

- Standalone components, signals for local state, `inject()` over constructor injection, `OnPush`-style reactivity, new control flow (`@if`/`@for`).
- Each feature owns its routes file, pages, components and API service (`<feature>/data/*.service.ts`).
- **RTL/LTR and i18n**: Transloco loads `public/i18n/<lang>.json`. `core/i18n/LanguageService` is the only place that changes language. It updates Transloco, `<html lang dir>` and CDK `Directionality` together. Arabic/RTL is the default. Styles must use CSS logical properties so both directions work.
- **UI kit**: Angular Material 3 (theme in `src/styles.scss`). Use `BreakpointObserver` from the CDK for responsive behaviour that CSS alone can't handle.
- Development: `ng serve` proxies `/api` to the backend (`proxy.conf.json`), so CORS is only needed for split-origin deployments.

## 5. Testing strategy

| Level | Where | What |
|---|---|---|
| Unit | `Ims.UnitTests` (xUnit) | Domain state transitions, grade calculation, Application use cases |
| Integration | `Ims.IntegrationTests` (xUnit v3 + `WebApplicationFactory` + Testcontainers PostgreSQL) | Endpoints, authorization per role, audit/no-delete behaviour, against real PostgreSQL. Shared fixture: `Infrastructure/ImsApiFactory` |
| Frontend unit | `frontend` (Vitest via `ng test`) | Components, services, guards |

## 6. Environments & runtime

- .NET SDK 10 (pinned by `global.json`) and Node 22 (`.nvmrc`; Angular 22 requires Node ≥ 22.22).
- Local PostgreSQL: `compose.yaml` (PostgreSQL 18.6, host port 5434, named volume `ims-db-data`). Credentials are in the git-ignored `.env` and the API connection string is in user-secrets. No cloud resources are configured.
- Ports: API `http://localhost:5106` / `https://localhost:7146`, SPA `http://localhost:4200`, PostgreSQL `localhost:5434`.
