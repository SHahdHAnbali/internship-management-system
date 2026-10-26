# Decisions, Assumptions & Open Questions

## A. Architecture decisions (made during initialization)

| # | Decision | Rationale |
|---|---|---|
| AD-1 | Modular monolith: one API, one DB, one SPA | One developer, about 11 weeks, a single cloud host (PDF §9–10) |
| AD-2 | 4 backend projects (Domain / Application / Infrastructure / Api) with feature folders | External vendors are undecided, and the lifecycle rules need to be testable. See [architecture.md](architecture.md) §2 |
| AD-3 | No MediatR, no generic repositories. `IAppDbContext` exposes `DbSet`s | EF Core is already a unit of work. Fewer abstractions |
| AD-4 | Controllers (not Minimal APIs) | Many endpoints grouped by role and feature, attribute-based authorization, familiar to the team |
| AD-5 | Audit and no-delete enforced in one EF Core `SaveChanges` interceptor | PDF requires audit on **every** change and no hard delete on **any** record |
| AD-6 | Domain entity named `TrainingApplication` (PDF: `Application`) | Avoids confusion with the `Ims.Application` layer and ASP.NET "application" |
| AD-7 | Staff users stored in one `Employee` table with a `StaffRole` (Employee/HR/Admin), trainees in a separate `Trainee` table | Matches the PDF data model. The two groups use different sign-in methods |
| AD-8 | `Guid` v7 primary keys and a separate random short code for certificates | Time-ordered keys. The public code must be unguessable (PDF §5) |
| AD-9 | .NET 10 (LTS), Angular 22, Node 22, Central Package Management, warnings as errors | Current supported versions. Consistent dependency versions |
| AD-10 | Angular: one app, lazy area per role, standalone components and signals, Vitest (CLI default) | PDF: "one interface with three role areas, plus a lightweight public certificate page" |
| AD-11 | Dev proxy `/api` → backend. CORS origins come from configuration | No CORS friction locally, explicit origins in production |
| AD-12 | **Session = HttpOnly cookie** issued by the API (built-in cookie authentication, no JWT package). Google ID tokens are verified server-side with `Google.Apis.Auth` | The SPA and API share an origin (dev proxy, single host), so a cookie keeps tokens out of JavaScript. Needs no extra package. Cookie: `SameSite=Strict`, `Secure` outside Development, 401/403 instead of redirects |
| AD-13 | **Secure by default**: a fallback authorization policy requires an authenticated user. Public endpoints opt out with `[AllowAnonymous]` | Trainee isolation and role restrictions are the core security requirement. Forgetting an attribute fails closed |
| AD-14 | **Validation**: built-in DataAnnotations plus `[ApiController]` automatic 400 `ProblemDetails`. No FluentValidation | Sufficient for form-style input. Business-rule validation lives in Domain methods |
| AD-15 | **Logging**: built-in `ILogger` with the JSON console formatter outside Development (structured, UTC timestamps, scopes) and single-line text in Development. No Serilog | Structured logs without a dependency. Revisit if the hosting choice (Q10) needs a specific log sink |
| AD-16 | **i18n: Transloco** (runtime switching). `LanguageService` keeps Transloco, `<html lang/dir>` and CDK `Directionality` in sync. Language persisted per browser | Assumed answer to Q20: a runtime switch is expected. `@angular/localize` would need one build per language |
| AD-17 | **UI: Angular Material 3 + CDK** only. Fonts: Roboto (Latin) with Noto Sans Arabic as the Arabic fallback | One component library with built-in bidi support. Roboto has no Arabic glyphs |
| AD-18 | **Tests: xUnit v3 on Microsoft.Testing.Platform** (opted in via `global.json`). Integration tests use `WebApplicationFactory` and a Testcontainers PostgreSQL 18.6 | xUnit 2 is deprecated. The .NET 10 SDK requires the platform opt-in. `coverlet.collector` dropped because it is VSTest-only |
| AD-19 | **Local DB: Docker Compose PostgreSQL 18.6** on host port **5434** (localhost-only bind), credentials in a git-ignored `.env`, API connection string in `dotnet user-secrets` | Ports 5432/5433 are taken by a native PostgreSQL install on the dev machine. No secrets in tracked files |
| AD-20 | Frontend `overrides.vite = 8.3.5` | `@angular/build` 22.2.4 pins Vite 8.3.0 (high-severity advisories, dev server only). **Remove the override** once a stable `@angular/build` ships with a patched Vite |
| AD-29 | **Tailwind CSS v4 is the primary styling approach** (layout, spacing, responsiveness in templates), installed with Angular's built-in `ng add tailwindcss` integration (`@tailwindcss/postcss`). SCSS is kept for design tokens, the Material theme and Material overrides. Tailwind's theme reads the same `--ims-*` tokens, and its default colour palette is removed | Requested by the project owner (2026-10-26). Tailwind was **not** previously installed (only `postcss`, as a transitive dependency of `@angular/build`), so it was added here. Material remains the component library. AD-21–AD-28 were used by the reverted domain branch (`backup/domain-implementation`) |

## B. Assumptions (reasonable defaults, change if wrong)

1. **Arabic is the default UI language** (`<html lang="ar" dir="rtl">`), with English as the second language. The PDF names both and is written in Arabic.
2. All timestamps are stored in UTC. Assignment start and end are calendar dates. The company time zone is assumed to be the operating zone for reminders.
3. The API issues its own session cookie after verifying a Google sign-in or a trainee email code, so both identity types share one authorization model (AD-12). The session idle timeout defaults to 8 hours (`Authentication:Session:IdleTimeoutMinutes`). The PDF does not specify one.
4. API routes are served under `/api`. The public certificate page is an SPA route `/c/:code`, matching the PDF example `training.company.com/c/X7K2P9`.
5. The "status" values of `TrainingApplication` and `Assignment` in [domain-model.md](domain-model.md) are proposals. The PDF only fixes `MentorRequest` statuses (Pending/Approved/Rejected).

## C. Open questions: from the PDF (§11, "points to settle")

| # | Question | PDF's proposal |
|---|---|---|
| Q1 | Is the certificate page published automatically or by the trainee's choice? | By the trainee |
| Q2 | Does the public page show numeric scores or only an overall grade? | Overall grade only |
| Q3 | What are the evaluation criteria and their weights? | Needs a list from HR |
| Q4 | Does the mentor's name appear on the certificate? | — (also listed as content in §5) |
| Q5 | Is there a maximum number of concurrent trainees per employee? | — |
| Q6 | Do we track attendance or daily hours, or is the start/end period enough? | — |
| Q7 | Are there specific university forms the system must print? | — |
| Q8 | Who signs the certificate, and is an electronic signature needed? | (§5 says "HR signature") |
| Q9 | Do we import data for past trainees? | (PDF adds about 1 week if so) |
| Q10 | Domain, system name, and hosting (Azure or AWS) | — |

## D. Open questions: found during analysis (not in the PDF)

| # | Question | Why it matters |
|---|---|---|
| Q11 | How do total scores map to grades (Excellent / Very good / Good)? Is there a grade below "Good"? | Needed for `Evaluation.Grade` and the public page |
| Q12 | When a trainee is **transferred**, each assignment "ends with an evaluation" (PDF §8). Which evaluation and mentor appear on the certificate: the last, all, or a combination? | Certificate content and report averages |
| Q13 | The matrix lets **HR evaluate** as well. Does HR fill the same form for any trainee, or only override or complete late evaluations? | Evaluation permissions |
| Q14 | "Notify field employees" implies an employee↔field link, but `Employee` has no field column in the PDF model. Many-to-many? Who sets it: Admin or the employee? | Data model and the notification opt-out |
| Q15 | Application statuses are not enumerated. Is an explicit "Under review" state needed, and what does the trainee status board show? | Status board, reports |
| Q16 | Can a trainee have two active applications at once (for example, in two fields)? | Validation rules |
| Q17 | How is the first Admin bootstrapped? (Seed by email from configuration is proposed) | Deployment |
| Q18 | Can a trainee change their email, and is phone verification needed? | Identity |
| Q19 | Maximum CV/letter file size and allowed types | Upload validation, storage cost |
| Q20 | Must the language switch at runtime, or is a per-locale build acceptable? | **Assumed runtime** (AD-16, Transloco). Confirm |
| Q21 | Data retention: are records kept forever (PDF: "nothing is deleted")? Any privacy or legal constraints on CVs? | Storage policy |
| Q22 | Which CAPTCHA provider (reCAPTCHA, hCaptcha, Turnstile)? | Application form security |
| Q30 | **Certificate template (Admin, PDF §4):** what exactly can the Admin edit (layout HTML, texts, logo, HR signature image) and in which languages? Logo and signature images also need file storage (vendor not chosen, Q10) | Admin module: not implemented until answered |
| Q31 | **Removing an evaluation criterion:** the PDF lists only name, weight and order, has no active flag, and forbids deletion. How does an Admin retire a criterion? | Admin module: criteria can be added and edited only |
| Q32 | **Department of a staff member:** the PDF's Employee table has it, but Google sign-in doesn't provide it. Who sets it, and can the Admin edit it? | Admin users page shows it read-only |

## E. Dependencies

Versions are pinned centrally in `backend/Directory.Packages.props` and `frontend/package.json`.

### Installed (foundation step, 2026-10-25)

| Package | Version | Project |
|---|---|---|
| `Microsoft.EntityFrameworkCore` | 10.0.13 | Ims.Application |
| `Npgsql.EntityFrameworkCore.PostgreSQL` | 10.0.3 | Ims.Infrastructure |
| `Google.Apis.Auth` | 1.77.0 | Ims.Infrastructure |
| `Microsoft.EntityFrameworkCore.Design` | 10.0.13 | Ims.Api (private, design-time only) |
| `Microsoft.AspNetCore.OpenApi` | 10.0.13 | Ims.Api |
| `dotnet-ef` (local tool, `dotnet-tools.json`) | 10.0.13 | repo root: `dotnet tool restore` |
| `xunit.v3` / `xunit.runner.visualstudio` / `Microsoft.NET.Test.Sdk` | 4.0.2 / 4.0.1 / 18.11.0 | both test projects |
| `Microsoft.AspNetCore.Mvc.Testing` | 10.0.13 | Ims.IntegrationTests |
| `Testcontainers.PostgreSql` | 4.16.0 | Ims.IntegrationTests |
| `@angular/material`, `@angular/cdk` | 22.2.4 | frontend |
| `@jsverse/transloco` | 8.4.0 | frontend |
| `tailwindcss`, `@tailwindcss/postcss`, `postcss` | 4.3.3, 4.3.3, 8.5.31 | frontend (dev), 2026-10-26, AD-29 |

Used from the shared framework (no install): cookie authentication, authorization, rate limiting, ProblemDetails, health checks, data protection, JSON console logging, `TimeProvider`.

### Still to add in Phase 1 (once vendors are decided)

| Package | Project | Purpose |
|---|---|---|
| Email provider SDK: `SendGrid` **or** `AWSSDK.SimpleEmailV2` | Infrastructure | Decided by Q10 / hosting |
| Storage SDK: `Azure.Storage.Blobs` **or** `AWSSDK.S3` | Infrastructure | CV and letter uploads. Decided by Q10 |
| `Microsoft.AspNetCore.DataProtection.EntityFrameworkCore` (or the host's key store) | Infrastructure | Persist cookie-encryption keys so sessions survive restarts and scale-out. Needed before the first deployment |
| `Microsoft.Testing.Extensions.CodeCoverage` (optional) | test projects | Coverage on Microsoft.Testing.Platform |

### Backend, Phases 2–3

| Package | Purpose |
|---|---|
| `QRCoder` | QR codes on certificates |
| An HTML→PDF engine (`Microsoft.Playwright` or `PuppeteerSharp`) | PDF says "generate from an HTML template on the server" |
| `ClosedXML` | Excel export of reports |
| `Hangfire.AspNetCore` + `Hangfire.PostgreSql` (or a built-in `BackgroundService`) | Reminders and the weekly summary |

### Frontend, still to add

| Package | Purpose |
|---|---|
| Google Identity Services (script tag, no npm package) | Staff Google sign-in button |
| CAPTCHA widget | Q22 |

### Local tooling

- Docker Desktop is required for the local database and the integration tests. It must be running.
- `psql` is not on `PATH`. Use `docker exec -it ims-db-1 psql -U ims -d ims_dev`, or the native client at `/Library/PostgreSQL/18/bin/psql`.
- Node 22 must be selected with `nvm use`, because the shell default is Node 20.
