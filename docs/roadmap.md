# Roadmap: incremental feature plan

Follows the PDF phases (§10). Each item is one vertical slice with tests. Since 2026-10-27 the production API is the
Cloudflare Worker (`backend-workers/`, AD-38); the EF Core migrations in `backend/` still own the schema.
Status as of 2026-11-04, e-mail items updated 2026-11-10 ("in production" = deployed to the Worker and Pages, [deployment.md](deployment.md)).
Requirement-by-requirement status: [requirements-progress.md](requirements-progress.md). Open questions: [decisions.md](decisions.md) §C–D.

## Step 0: Foundation
- [x] Foundation packages, Docker Compose PostgreSQL, runtime AR/EN (now React, AD-34)
- [x] Database, health check, schema owned by EF Core migrations (8 applied), audit and no-delete triggers on every table (`ims_protect_table`)
- [x] Authentication: staff Google (staff domains, auto Employee) and trainee passwordless link/code (15 min); persistent server-side sessions (AD-44)
- [x] Frontend role guards and AR/EN switcher
- [x] First Admin bootstrap (Q17 answered: first Admin in the database 2026-10-28, second Admin AD-46)
- [x] Session keys: the Worker encrypts the session with a Workers secret (AD-40); ASP.NET Data Protection keys are not needed in production

## Phase 1: Core (MVP, about 6 weeks)
- [x] Admin: fields, evaluation criteria (the AD-66 model in production since 2026-11-18: Arabic and English names, an automatic order that never changes, an active flag, no weights), users and roles, notification intervals, certificate template (AD-43), accepted trainees (in production)
- [x] Trainee: application form with CV/letter upload (R2, AD-48), application status board (in production; since 2026-11-10 it also shows the rejection reason of a rejected application, AD-61, production visual verification pending a legitimate rejected application). CAPTCHA out of scope (owner 2026-11-16, Q22). Not yet: the board after acceptance (L10)
- [x] HR: applications inbox, Under Review, accept, reject with reason, contact log (AD-47, in production)
- [x] Employee: available trainees with filters and CV view, mentor request (in production)
- [x] HR: approve/reject mentor requests with dates (**done**, AD-49, in production); direct assignment (**done, in production since 2026-11-14**, AD-67)
- [ ] Employee: my trainees and progress notes (**done**, in production); final evaluation form (**not built**; rules decided 2026-11-14, AD-66; stage S2.1, its schema and the evaluators' read-only pages, committed on 2026-11-22 (`e55e63c`, AD-69, not deployed); stage S2.2, the shared draft, committed and on GitHub on 2026-11-22 after its local tests and UAT (`1d53d71`, AD-70, not deployed); stage S2.3, submission and the verbal grade, implemented **locally only** on 2026-11-23 (AD-71; not committed or deployed); S2.4–S2.5 not built)
- [x] Audit log viewer: Admin only, read-only (AD-51); sign-in writes attributed to the verified user; least-privilege database role `ims_app` (AD-52) (in production)
- [ ] E-mails: transport **done** (Gmail SMTP with Nodemailer, AD-58, replaces SendGrid; verified in production on 2026-11-10 with the trainee sign-in e-mail); the eight event e-mails of the existing workflows **in production since 2026-11-11** (Worker `55570602`, best effort, manually tested by the owner locally; NEW-24 HR recipients, NEW-30 mentor details); still missing: reminders, weekly summary, training-ended, late-evaluation and certificate e-mails, and delivery tracking/retries (Phase 3) (decided 2026-11-10: channels AD-59; sender name, HTML + text and retries AD-60; rejection reason AD-61; open NEW-19 to NEW-23, NEW-29 (answered: NEW-25 on 2026-11-10; NEW-24 for these e-mails and NEW-30 on 2026-11-11))

## Phase 2: Certificates & reports (about 3 weeks)
- [ ] Certificate generation, public page `/c/:code`, publish/private, revoke (**blocked**: L1, L7, Q2, Q4, Q11; domain Q10)
- [ ] PDF and QR (**blocked** with certificates; Q8)
- [ ] Reports: monthly (**done**), fields (**partly**: no completed count, L1), mentor profile (**partly**: no average or "over time", NEW-03, NEW-13), trainee history (**done**); hiring pipeline (**not built**: needs evaluations)
- [x] Excel and PDF export of the built reports (in production since 2026-11-04, verified by the owner; AD-55: in the browser, from the data each page shows; Arabic PDFs with embedded Noto fonts)

## Phase 3: Automation (about 2 weeks)
- [ ] Scheduled reminders (7-day, end-of-training, late evaluation every 3 days, 5-day pending) and the weekly summary (the 5-day pending reminder is fully decided 2026-11-14 and 2026-11-15, AD-61 items 4–17, **in production since 2026-11-15** (Worker `c007ee03`; first run 2026-11-16, no candidates), only for requests created at or after its first production activation (AD-61 item 18); the 7-day notice and the late-evaluation reminders decided (AD-66, NEW-37), not built; the weekly summary **blocked**: NEW-27, NEW-28, NEW-31 (L1 answered, AD-63); NEW-04 partly, NEW-05 and NEW-09 answered 2026-11-10, AD-61, AD-62; scheduled jobs exist (AD-65 transfers, NEW-05 reminders); the e-mail transport is available, AD-58)
- [x] Progress notes: core in production since 2026-10-29. Open: B2, B5, B7, B8, Q37, Q40
- [ ] Transfer, extend, end early, withdraw (rules decided 2026-11-11, AD-63; **complete, end early and withdraw in production since 2026-11-12**, Worker `ca7ec2a0`; **extend in production since 2026-11-12**, Worker `422b35e8` (NEW-35); **transfer, immediate or scheduled, in production since 2026-11-13**, Worker `beaf2d36` (AD-65, L5 answered and revised 2026-11-13; the Worker's first Cron Trigger executes scheduled transfers); return to Active not built, **blocked**: NEW-34; the final evaluation follows the ending (D1))
- [ ] Admin settings: criteria, weights and intervals (**done**); certificate template (**done**, AD-43); e-mail templates AR/EN (**partly**: format decided 2026-11-10, AD-60; the bilingual HTML layout is used by the sign-in e-mail only, deployed and verified in production by the owner on 2026-11-10; event e-mail templates not built)
- [ ] LinkedIn share (**blocked** with certificates)
- [ ] In-app notifications (**partly**, in production since 2026-11-02, AD-50: four events, HR and Employee); "new trainee in your field" and its opt-out (Q14); 7-day and training-ended notifications (lifecycle, scheduling)

## Deferred by the owner
- Automated daily database backups: after the remaining development (AD-54; Neon restore window 6 hours)
- Attendance or weekly hours tracking (Q6)
- HR ownership of individual trainees (NEW-10); the responsible HR of each accepted application and the mentor-request routing are **in production since 2026-11-13** (AD-64, Worker `e7913829`)
