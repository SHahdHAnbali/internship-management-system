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
- [x] Admin: fields, evaluation criteria and weights, users and roles, notification intervals, certificate template (AD-43), accepted trainees (in production)
- [x] Trainee: application form with CV/letter upload (R2, AD-48), application status board (in production). Not yet: CAPTCHA (Q22), the board after acceptance (L10)
- [x] HR: applications inbox, Under Review, accept, reject with reason, contact log (AD-47, in production)
- [x] Employee: available trainees with filters and CV view, mentor request (in production)
- [ ] HR: approve/reject mentor requests with dates (**done**, AD-49, in production); direct assignment (**not built**: Q38, L5)
- [ ] Employee: my trainees and progress notes (**done**, in production); final evaluation form (**not built**: Q3, N1–N7, Q11, Q13, L6)
- [x] Audit log viewer: Admin only, read-only (AD-51); sign-in writes attributed to the verified user; least-privilege database role `ims_app` (AD-52) (in production)
- [ ] E-mails: transport **done** (Gmail SMTP with Nodemailer, AD-58, replaces SendGrid; verified in production on 2026-11-10 with the trainee sign-in e-mail); application received, accepted/rejected, assignment approved/rejected **not built** (NEW-01 display name, NEW-07; channels settled by Q42, AD-59)

## Phase 2: Certificates & reports (about 3 weeks)
- [ ] Certificate generation, public page `/c/:code`, publish/private, revoke (**blocked**: L1, L7, Q2, Q4, Q11; domain Q10)
- [ ] PDF and QR (**blocked** with certificates; Q8)
- [ ] Reports: monthly (**done**), fields (**partly**: no completed count, L1), mentor profile (**partly**: no average or "over time", NEW-03, NEW-13), trainee history (**done**); hiring pipeline (**not built**: needs evaluations)
- [x] Excel and PDF export of the built reports (in production since 2026-11-04, verified by the owner; AD-55: in the browser, from the data each page shows; Arabic PDFs with embedded Noto fonts)

## Phase 3: Automation (about 2 weeks)
- [ ] Scheduled reminders (7-day, end-of-training, late evaluation every 3 days, 5-day pending) and the weekly summary (**blocked**: NEW-04, NEW-05, NEW-06, NEW-09, L1, N3; no scheduled jobs yet; the e-mail transport is available, AD-58)
- [x] Progress notes: core in production since 2026-10-29. Open: B2, B5, B7, B8, Q37, Q40
- [ ] Transfer, extend, end early, withdraw (**blocked**: L1–L5, L8, L9)
- [ ] Admin settings: criteria, weights and intervals (**done**); certificate template (**done**, AD-43); e-mail templates AR/EN (**not built**: NEW-07, NEW-01; the sign-in e-mail has a bilingual subject and an English body)
- [ ] LinkedIn share (**blocked** with certificates)
- [ ] In-app notifications (**partly**, in production since 2026-11-02, AD-50: four events, HR and Employee); "new trainee in your field" and its opt-out (Q14); 7-day and training-ended notifications (lifecycle, scheduling)

## Deferred by the owner
- Automated daily database backups: after the remaining development (AD-54; Neon restore window 6 hours)
- Attendance or weekly hours tracking (Q6)
- HR ownership of individual trainees (NEW-10)
