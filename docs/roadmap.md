# Roadmap: incremental feature plan

Follows the PDF phases (§10). Each item is one vertical slice: Domain → Application → Infrastructure (EF configuration + migration) → Api → Angular feature → tests.
Mark items done here as they ship.

## Step 0: Foundation (next)
- [x] Install foundation packages ([decisions.md](decisions.md) §E), Docker Compose PostgreSQL, Material + Transloco with an AR/EN runtime switch
- [x] `AppDbContext` (empty), `IAppDbContext`, DB health check
- [x] Cookie authentication scheme and role policies wired (no sign-in endpoints yet)
- [ ] First entities and the first migration (baseline schema)
- [ ] `AuditInterceptor` with the no-delete guard, plus `ICurrentUser` and `IClock`
- [ ] Authentication: staff Google (domain-restricted, auto-create as Employee) and trainee passwordless link/code (15 min)
- [ ] Angular role guards. App shell with the AR/EN switcher UI (the `LanguageService` already exists)
- [ ] Persist Data Protection keys (sessions survive restarts)
- [ ] First Admin bootstrap (Q17)

## Phase 1: Core (MVP, about 6 weeks)
- [ ] Admin: fields CRUD (deactivate, never delete), users and roles
- [ ] Trainee: application form with CV/letter upload, status board
- [ ] HR: applications inbox, contact log, accept/reject with reason
- [ ] Employee: available-trainees list with filters and CV view, mentor request
- [ ] HR: approve/reject mentor requests (sets start/end), direct assignment
- [ ] Employee: my trainees. Final evaluation form (criteria from Admin)
- [ ] Audit log viewer
- [ ] Emails: application received, accepted/rejected, assignment approved/rejected

## Phase 2: Certificates & reports (about 3 weeks)
- [ ] Certificate generation, public page `/c/:code`, publish/private, revoke
- [ ] PDF and QR
- [ ] Monthly, fields, mentor profile, hiring pipeline, and trainee history reports
- [ ] Excel and PDF export

## Phase 3: Automation (about 2 weeks)
- [ ] Scheduled reminders (7-day, end-of-training, late evaluation every 3 days, 5-day pending) and the weekly summary
- [ ] Progress notes
- [ ] Transfer, extend, end early, withdraw
- [ ] Admin settings: evaluation criteria and weights, intervals, certificate and email templates (AR/EN)
- [ ] LinkedIn share
- [ ] In-app notifications and per-field opt-out
