# Roadmap: incremental feature plan

Follows the PDF phases (§10). Each item is one vertical slice: Domain → Application → Infrastructure (EF configuration + migration) → Api → React feature → tests.
Mark items done here as they ship.

## Step 0: Foundation (next)
- [x] Install foundation packages ([decisions.md](decisions.md) §E), Docker Compose PostgreSQL, Material + Transloco with an AR/EN runtime switch
- [x] `AppDbContext` (empty), `IAppDbContext`, DB health check
- [x] Cookie authentication scheme and role policies wired (no sign-in endpoints yet)
- [ ] First entities and the first migration (baseline schema)
- [ ] `AuditInterceptor` with the no-delete guard, plus `ICurrentUser` and `IClock`
- [x] Authentication: staff Google (domain-restricted, auto-create as Employee) and trainee passwordless link/code (15 min). Needs external configuration ([authentication.md](authentication.md))
- [x] Frontend role guards and AR/EN switcher (React, after the 2026-10-27 migration)
- [ ] Persist Data Protection keys (sessions survive restarts)
- [ ] First Admin bootstrap (Q17)

## Phase 1: Core (MVP, about 6 weeks)
- [x] Admin: fields (add/edit/activate-deactivate), evaluation criteria and weights, users and their roles, notification intervals (7/3/5 days). `roles` table with the 4 roles. Certificate template: done (AD-43, Workers API). Not yet: viewing accepted trainees and reports (see decisions.md §D, Q30–Q32)
- [x] Trainee: application form with CV/letter upload (R2, AD-48), status board (local; not deployed). CAPTCHA (Q22) and e-mails not yet
- [ ] HR: applications inbox, contact log, accept/reject with reason. Done locally: inbox, Under Review, accept, reject with reason, contact log (AD-47)
- [x] Employee: available-trainees list with filters and CV view, mentor request (local; not deployed)
- [ ] HR: approve/reject mentor requests (sets start/end), direct assignment. Done locally: approve with dates / reject (AD-49). Not yet: direct assignment
- [ ] Employee: my trainees. Final evaluation form (criteria from Admin). Done and deployed (2026-10-29): my trainees (current, previous, requests) and periodic progress notes (core, see Phase 3). Not yet: final evaluation
- [ ] Audit log viewer
- [ ] Admin: accepted trainees (PDF §2), HR: trainings list (read-only) and the trainee history report under HR › Reports (PDF §6; the other reports, filters and export not built). Done locally, not deployed (2026-10-31)
- [ ] Emails: application received, accepted/rejected, assignment approved/rejected

## Phase 2: Certificates & reports (about 3 weeks)
- [ ] Certificate generation, public page `/c/:code`, publish/private, revoke
- [ ] PDF and QR
- [ ] Monthly, fields, mentor profile, hiring pipeline, and trainee history reports
- [ ] Excel and PDF export

## Phase 3: Automation (about 2 weeks)
- [ ] Scheduled reminders (7-day, end-of-training, late evaluation every 3 days, 5-day pending) and the weekly summary
- [x] Progress notes: core deployed to production 2026-10-29 (Worker API, Employee "My trainees"): an employee writes and reads notes on their own Active trainees; no deletion; audited. A failed load shows an error instead of an empty list (local, not deployed). Not yet: notes of previous trainees in the web app. Open decisions, not owner-approved: editing and who else reads notes (Q37), the note date (Q40), notes only while Active (AD-49), notes after a transfer, text rules, access after a role change ([deferred-features.md](deferred-features.md) D-32)
- [ ] Transfer, extend, end early, withdraw
- [ ] Admin settings: evaluation criteria and weights, intervals, certificate and email templates (AR/EN)
- [ ] LinkedIn share
- [ ] In-app notifications and per-field opt-out. Done locally, not deployed (2026-10-31, AD-50): the four in-app events whose workflow exists, with "load more" pages (owner decisions C2–C5). Deployment waits for Q41 (C1). Not yet: "new trainee in your field" with its opt-out (Q14), the 7-day and training-ended notifications (lifecycle, scheduling)
