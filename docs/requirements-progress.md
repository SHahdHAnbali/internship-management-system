# Requirements Progress

Tracks every functional requirement of the original requirements PDF (*خطة نظام إدارة المتدربين*, 22 Oct 2026, the single source of truth) against the **actual code**: backend, database migration, frontend and tests.
Last verified: **2026-10-27**, against `main` @ `8f3d4bf` plus the uncommitted working tree (Admin Preview Mode, public homepage, authentication & authorization, React frontend).

**Status:** ✅ Completed (implemented, functional and tested) · 🟡 Partial (some required behaviour missing) · ❌ Not completed. For ❌ rows, the Notes say **Not started** (nothing blocks it except building it) or **Deferred** (blocked by an unfinished module). `D-xx` refers to [deferred-features.md](deferred-features.md) and `Qxx` to [decisions.md](decisions.md).

## Summary

| Metric | Count | Share |
|---|---|---|
| **Total PDF requirements** | **76** | 100% |
| ✅ Completed | 15 | 19.7% |
| 🟡 Partial | 8 | 10.5% |
| ❌ Not completed | 53 | 69.7% |
| ↳ Deferred (blocked by another module) | 48 | 63.2% |
| ↳ Not started (no module dependency) | 5 | 6.6% |
| **Overall completion** | | **19.7%** fully completed · **25.0%** counting partial items as half |

**By module**

| Module | Total | ✅ | 🟡 | ❌ |
|---|---|---|---|---|
| Authentication & Authorization | 8 | 4 | 4 | 0 |
| Admin | 7 | 4 | 0 | 3 |
| Trainee | 5 | 0 | 0 | 5 |
| Employee | 4 | 0 | 0 | 4 |
| HR | 8 | 0 | 0 | 8 |
| Certificates | 7 | 0 | 0 | 7 |
| Reports | 7 | 0 | 0 | 7 |
| Notifications | 15 | 0 | 2 | 13 |
| Records & Data Integrity | 3 | 2 | 1 | 0 |
| Platform & Technical | 12 | 4 | 1 | 7 |

**Reading this correctly:** sign-in now works. Trainee e-mail sign-in has been verified end-to-end in the browser (in Development the code is written to the API log). Staff Google sign-in is complete in code and tested, but **becomes usable only after the external configuration in [authentication.md](authentication.md) is provided**: a Google OAuth client ID, the company domain, the first Admin, and an e-mail provider for real delivery. Admin Preview Mode is a development tool and doesn't count as completion.

## Requirements by module

### Authentication & Authorization

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 1 | Authentication & Authorization | Four roles: Trainee, Employee, HR, Admin (§2) | ✅ | `roles` table seeded with exactly `Admin`, `HR`, `Trainee`, `Employee`. `UserRole` enum and `AuthRoles` match. A staff member's role is restricted to Employee/HR/Admin (DB CHECK + domain). Covered by tests |
| 2 | Authentication & Authorization | Staff (Employee, HR, Admin) sign in with Google (§2, §9) | 🟡 | Implemented: Google's sign-in button (Google Identity Services) on `/sign-in` → `POST /api/auth/staff/google` verifies the ID token server-side with `Google.Apis.Auth` (signature, issuer, expiry, client id) → HttpOnly session cookie → redirect to the role's area. Tested end-to-end with a stand-in for Google's token check. **Not yet operational**: it needs a Google OAuth client ID and the company domain (`Authentication:Google:*`), so it hasn't been verified against real Google |
| 3 | Authentication & Authorization | Google sign-in restricted to the company domain (§2, §9) | ✅ | Enforced server-side: the token's Workspace `hd` claim must equal the configured domain, the e-mail must end with `@domain` and be verified, otherwise 403 and no account is created. Tested (gmail, other domain, company address without `hd`). The actual domain value must be supplied (Q10) |
| 4 | Authentication & Authorization | A new account from the company domain is created automatically with the Employee role (§2) | ✅ | First successful Google sign-in creates the `employees` row with role Employee. Later sign-ins reuse it (case-insensitive e-mail). Tested |
| 5 | Authentication & Authorization | Trainee registration and sign-in by email only: one-time link or code, no password (§2, §4, §9) | 🟡 | Implemented: `/sign-in` → e-mail → 6-digit code + one-time link (only SHA-256 hashes stored; single use; a newer request replaces the old one; locked after 5 wrong codes; rate-limited; no account enumeration). The `trainees` account is created on first verification. Verified in the browser end-to-end and by tests. **Missing**: real e-mail delivery. In Development the e-mail is written to the API log, and elsewhere the request fails with 503 until an e-mail provider exists (#71) |
| 6 | Authentication & Authorization | Trainee sign-in link valid for 15 minutes (§9) | ✅ | Link and code expire 15 minutes after issue (`Authentication:Trainee:CodeLifetimeMinutes`). Tested with a controlled clock: valid at 14.9 min, rejected at 15 min |
| 7 | Authentication & Authorization | Role-based permissions on the API (§2 matrix, §9) | 🟡 | Real sessions now carry the role from PostgreSQL, re-checked on every request (an Admin's role change applies immediately; deleted accounts are signed out). Fallback policy requires sign-in everywhere. Admin endpoints enforce `Admin` (tested with real cookies for Employee, HR, Trainee). Frontend role guards protect `/admin`, `/hr`, `/employee`, `/trainee`. **Remaining**: the matrix permissions of HR/Employee/Trainee features apply as those endpoints are built |
| 8 | Authentication & Authorization | Trainees never see each other; a trainee can access only their own data (§2, §9 Security) | 🟡 | Enforced for everything that exists: a trainee can reach only `GET /api/auth/me` (their own account, from their session id) and gets 403 on every staff endpoint. Tested with two trainees. **Remaining**: application data and its scoping come with the Trainee module |

### Admin

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 9 | Admin | Manage training fields (Frontend, Backend, QA, Design…) (§4 Admin, §8 Field) | ✅ | Add, edit, activate/deactivate (no deletion). Names are unique ignoring case (409 on duplicates). API `api/admin/fields` and Angular page, with unit, integration and UI tests. Using it in a browser needs Admin sign-in (Auth rows) |
| 10 | Admin | Manage evaluation criteria and their weights (name, weight, order) (§4 Admin, §8) | ✅ | Add and edit name, weight (> 0) and order. API `api/admin/evaluation-criteria` and Angular page, tested. How to retire a criterion is unspecified (Q31), so the PDF gives it no delete or active flag |
| 11 | Admin | Manage users and their roles; Admin grants higher roles (§2, §4 Admin) | ✅ | Staff accounts appear after their first Google sign-in. The Admin lists them and grants Employee/HR/Admin (Trainee refused), and a non-Admin can't change roles (tested with real sessions). The change applies to the user's current session. Department is shown read-only (Q32). Making the **first** Admin is a one-time operator step (Q17, see docs/authentication.md) |
| 12 | Admin | Manage the certificate template (§4 Admin) | ✅ | Settings-based editor at `/admin/certificate` (AD-43): preset designs, typography, colours, border/background, logo and HR signature, QR placeholder, Arabic/English texts, live preview on labelled sample data, save/reset/unsaved-changes. Admin-only Workers API, validated, audited. Issuing real certificates, PDF and QR are later modules (#73) |
| 13 | Admin | Change the notification intervals: 7 days, 3 days, 5 days (§7) | ✅ | Single settings row seeded with 7/3/5, editable 1–365 via `api/admin/settings/notifications` and the Settings page, tested. The reminders that *use* these values are tracked under Notifications |
| 14 | Admin | View accepted trainees (§2 matrix: Admin ✔) | ❌ | **Deferred:** Trainee applications + HR acceptance (D-03) |
| 15 | Admin | Reports: all (§2 matrix, §6) | ❌ | **Deferred:** Reports module (D-04) |

### Trainee

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 16 | Trainee | Submit a training application: name, phone, university, major, study year, field, available period, hours, mandatory-for-university (§4 Trainee, §3 step 1) | ❌ | **Deferred:** Trainee authentication (D-11). The Admin-managed fields it uses are available. The homepage *Apply* button is a disabled placeholder |
| 17 | Trainee | Upload CV and any university letter (§4 Trainee) | ❌ | **Deferred:** File storage + application form (D-12) |
| 18 | Trainee | Status board: where my application is, without seeing other trainees (§4 Trainee) | ❌ | **Deferred:** Application form, HR decisions, assignments (D-13) |
| 19 | Trainee | Certificate: publish the page or keep it private; print or download as PDF (§4 Trainee, §5) | ❌ | **Deferred:** Certificates module (D-14) |
| 20 | Trainee | Apply again later (e.g. another field); every training stays on record (§4 Trainee) | ❌ | **Deferred:** Application form (D-15) |

### Employee

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 21 | Employee | Available trainees list (accepted, unassigned), filterable by field, university and period, with CV view (§4 Employee) | ❌ | **Deferred:** HR acceptance + file storage (D-30) |
| 22 | Employee | "I want to train them" request with a short note, then wait for HR approval (§4 Employee, §3 step 5) | ❌ | **Deferred:** Available trainees list (D-31) |
| 23 | Employee | My trainees (current and past) with periodic progress notes during training (§4 Employee) | ❌ | **Deferred:** HR assignment approval (D-32) |
| 24 | Employee | Final evaluation of own trainees only: score per Admin criterion, comment, hiring recommendation Yes/Maybe/No (§4 Employee, §2, §3 step 8) | ❌ | **Deferred:** Assignments (D-33). The criteria it uses are available (Admin) |

### HR

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 25 | HR | New applications inbox: review, then accept, or reject with a reason (§4 HR, §3 steps 2–3) | ❌ | **Deferred:** Trainee application form (D-20) |
| 26 | HR | Contact log: record every call or verbal agreement (date, method, summary) (§4 HR, §8 ContactLog) | ❌ | **Deferred:** Applications (D-21) |
| 27 | HR | Mentor requests: see every request, approve after coordination and set start/end dates; rejection returns the trainee to the list (§4 HR, §3 step 6) | ❌ | **Deferred:** Employee mentor requests (D-22) |
| 28 | HR | Training starts only after two HR decisions: accept the application, then approve the assignment (§3) | ❌ | **Deferred:** Applications + assignments |
| 29 | HR | Direct assignment of a trainee to an employee without a request (§4 HR) | ❌ | **Deferred:** Accepted applications + staff accounts (D-23) |
| 30 | HR | Running training: extend, end early, transfer to another employee, record withdrawal, always with the reason (§4 HR, §3 step 7) | ❌ | **Deferred:** Assignments (D-24) |
| 31 | HR | HR can evaluate (§2 matrix: Evaluate ✔ for HR) | ❌ | **Deferred:** Evaluations (Employee module). The scope of HR evaluation is unspecified (Q13) |
| 32 | HR | View accepted trainees (§2 matrix: HR ✔) | ❌ | **Deferred:** Applications + acceptance |

### Certificates

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 33 | Certificates | Each completed training generates a page with a fixed link and a random, unguessable verification code (§5) | ❌ | **Deferred:** Evaluations (D-35). The SPA route prefix `/c` exists but is empty |
| 34 | Certificates | Page content: trainee name, field, university, period and hours, mentor name, overall grade, mentor's words (§5) | ❌ | **Deferred:** Certificates (D-35) |
| 35 | Certificates | QR code on the page and on the printed copy, opening the same page (§5) | ❌ | **Deferred:** Certificates (D-36) |
| 36 | Certificates | Official PDF with company logo and HR signature (§5) | ❌ | **Deferred:** Certificates + server-side PDF generation (D-36). The signer is unspecified (§11) |
| 37 | Certificates | "Share on LinkedIn" button (§5) | ❌ | **Deferred:** Public certificate page (D-37) |
| 38 | Certificates | Revocation by HR: the page stays and shows the certificate as invalid (§5) | ❌ | **Deferred:** Certificates (D-26) |
| 39 | Certificates | Public page shows an overall grade only; detailed scores stay internal (§5 proposal) | ❌ | **Deferred:** Evaluations + certificates. Grade mapping unspecified (Q11) |

### Reports

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 40 | Reports | Monthly report: everyone training during the month, with whom, field, from/to (§6) | ❌ | **Deferred:** Assignments (D-40) |
| 41 | Reports | Fields report: applications, accepted and completed per field (§6) | ❌ | **Deferred:** Applications + HR decisions (D-41) |
| 42 | Reports | Mentor profile: trainees per employee over time and average evaluation; HR, and each employee for themselves (§6) | ❌ | **Deferred:** Assignments + evaluations (D-42, D-34) |
| 43 | Reports | Hiring pipeline: trainees recommended for hiring, ranked by evaluation (§6) | ❌ | **Deferred:** Evaluations (D-43) |
| 44 | Reports | Trainee history: all trainings of one trainee and their contact notes (§6) | ❌ | **Deferred:** Applications + contact log (D-44) |
| 45 | Reports | Every report filterable by period, field and employee, exportable to Excel or PDF (§6) | ❌ | **Deferred:** The reports above (D-45) |
| 46 | Reports | Monthly report based on assignment start/end dates; a transfer is recorded as two separate assignments (§6 technical note) | ❌ | **Deferred:** Assignments (D-40) |

### Notifications

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 47 | Notifications | New training application → HR (email + in-app) (§7) | ❌ | **Deferred:** Trainee applications. No email service or notification store exists yet (D-50) |
| 48 | Notifications | Application received (confirmation) → Trainee (email) (§7) | ❌ | **Deferred:** Trainee applications. No email service or notification store exists yet (D-50) |
| 49 | Notifications | Application accepted or rejected → Trainee (email) (§7) | ❌ | **Deferred:** HR decisions. No email service or notification store exists yet (D-50) |
| 50 | Notifications | New available trainee in your field (optional, can be muted) → Employees of the field (in-app) (§7) | ❌ | **Deferred:** HR acceptance; employee↔field link unspecified (Q14). No email service or notification store exists yet (D-50) |
| 51 | Notifications | Employee requested to train a trainee → HR (email + in-app) (§7) | ❌ | **Deferred:** Employee mentor requests. No email service or notification store exists yet (D-50) |
| 52 | Notifications | Assignment approved or rejected → Employee (email + in-app) (§7) | ❌ | **Deferred:** HR assignment decisions. No email service or notification store exists yet (D-50) |
| 53 | Notifications | Assignment approved (start date and mentor details) → Trainee (email) (§7) | ❌ | **Deferred:** HR assignment decisions. No email service or notification store exists yet (D-50) |
| 54 | Notifications | Training ends soon (7 days before) → Employee and HR (in-app) (§7) | ❌ | **Deferred:** Assignments + scheduled jobs (interval setting ✅). No email service or notification store exists yet (D-51) |
| 55 | Notifications | Training ended: fill in the evaluation → Employee (email + in-app) (§7) | ❌ | **Deferred:** Assignments + evaluations. No email service or notification store exists yet (D-51) |
| 56 | Notifications | Late evaluation reminder (every 3 days; HR copied after the 2nd reminder) → Employee (+HR) (email) (§7) | ❌ | **Deferred:** Evaluations + scheduled jobs (interval setting ✅). No email service or notification store exists yet (D-51) |
| 57 | Notifications | Certificate ready (email with the page link) → Trainee (email) (§7) | ❌ | **Deferred:** Certificates. No email service or notification store exists yet (D-50) |
| 58 | Notifications | Request pending more than 5 days → HR (email) (§7) | ❌ | **Deferred:** Mentor requests + scheduled jobs (interval setting ✅). No email service or notification store exists yet (D-51) |
| 59 | Notifications | Weekly summary → HR (email) (§7) | ❌ | **Deferred:** Scheduled jobs + Trainee/HR modules. No email service or notification store exists yet (D-52) |
| 60 | Notifications | Sign-in link or code → Trainee (email) (§7) | 🟡 | The bilingual sign-in e-mail (code + link, validity) is generated and sent through the `IEmailSender` port. In Development it is written to the API log. **Missing**: a real e-mail provider (#71) |
| 61 | Notifications | Email templates in Arabic and English (§7) | 🟡 | The only e-mail so far (trainee sign-in) is bilingual Arabic + English. The other templates come with their events, and delivery needs an e-mail provider (D-53) |

### Records & Data Integrity

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 62 | Records & Data Integrity | Nothing is deleted; rejected, withdrawn and cancelled records keep their status (soft delete) (§6, §8) | ✅ | PostgreSQL triggers reject DELETE and TRUNCATE on every table (`ims_protect_table`), every FK is `RESTRICT`, and EF fails fast on deletes. Tested for all tables. Statuses such as rejected/withdrawn arrive with their modules and are covered automatically |
| 63 | Records & Data Integrity | Audit log: every change recorded with who did it and when, value before/after (§6, §8 AuditLog, §9) | ✅ | Database triggers write `audit_logs` in the same transaction for every INSERT/UPDATE on every table: actor (from the signed-in user), table, row, changed columns before/after, transaction id, time. Append-only and tamper-proof. Tested. The business actions the PDF names (accept, assign, transfer…) will be audited automatically once their modules exist |
| 64 | Records & Data Integrity | Data model: Trainee, Employee, Field, Application, MentorRequest, Assignment, ProgressNote, EvaluationCriterion, Evaluation, Certificate, ContactLog, Notification, AuditLog (§8) | 🟡 | Implemented: Employee, Field, EvaluationCriterion, AuditLog, Trainee (account: id and e-mail; the profile fields come with the application form), plus `roles`, notification settings and `trainee_sign_in_codes`. Missing: Application, MentorRequest, Assignment, ProgressNote, Evaluation, Certificate, ContactLog, Notification, which come with their modules |

### Platform & Technical

| ID | Module | Requirement / Feature | Status | Notes |
|---|---|---|---|---|
| 65 | Platform & Technical | Angular frontend, responsive (§9) | ✅ | **Implemented with React instead of Angular** by owner decision (AD-34, 2026-10-27): React 19 + TypeScript + Vite + Tailwind design system, checked at desktop and 390px phone width. The static frontend is hosted on Cloudflare Pages ([deployment.md](deployment.md)) |
| 66 | Platform & Technical | Arabic (RTL) and English interface (§9) | ✅ | Runtime switch (`I18nProvider`) loads the AR/EN translation files and flips `<html lang dir>`. All existing pages are translated in both languages and use logical (RTL-safe) layout |
| 67 | Platform & Technical | One interface with role-based areas plus a lightweight public certificate page (§9) | 🟡 | One React app: public homepage and sign-in, Admin area, and guarded HR/Employee/Trainee areas (landing page with the user's own account and sign-out only; their features aren't built). The public certificate page isn't built |
| 68 | Platform & Technical | ASP.NET Core Web API (§9) | ✅ | .NET 10 Web API with ProblemDetails errors, health check and OpenAPI. Running and tested |
| 69 | Platform & Technical | PostgreSQL database (§9) | ✅ | PostgreSQL 18 (Docker locally). EF Core migration `AdminModule` applied |
| 70 | Platform & Technical | Cloud file storage for CVs and university letters: S3 or Azure Blob (§9) | ❌ | **Not started.** No storage integration. Vendor undecided (Q10) |
| 71 | Platform & Technical | Email delivery service: SendGrid or Amazon SES, bilingual templates (§9) | ❌ | **Not started.** No email integration. Vendor undecided (Q10) |
| 72 | Platform & Technical | Scheduled jobs (Hangfire or similar) for reminders and the weekly summary (§9) | ❌ | **Not started.** No job scheduler |
| 73 | Platform & Technical | Server-side PDF and QR generation from an HTML template (§9) | ❌ | **Not started.** No PDF/QR library or renderer |
| 74 | Platform & Technical | Cloud hosting (Azure or AWS) with daily database backup (§9) | ❌ | **Not started.** Runs locally only. Hosting undecided (Q10) |
| 75 | Platform & Technical | Security: files served through temporary links (§9) | ❌ | **Deferred:** File storage |
| 76 | Platform & Technical | Security: application form protected with rate limiting and CAPTCHA (§9) | ❌ | **Deferred:** Trainee application form. CAPTCHA provider undecided (Q22). The rate limiter itself exists (used on trainee sign-in) |

### Additional work (not a PDF requirement, not counted above)

| Item | Status | Notes |
|---|---|---|
| Public homepage (`/`) | ✅ | Logo header, hero introducing the internship program, AR/EN. *Sign in* opens `/sign-in`, and *Apply* stays disabled until the application form exists (D-11). The PDF only asks for "one portal" (§1), so this is supporting work |
| Visual design system (Tailwind + SCSS tokens, React components) | ✅ | [design-system.md](design-system.md). The sign-in page follows the owner's reference screenshot (AD-36) |
| Frontend hosting on Cloudflare Pages | see [deployment.md](deployment.md) | Static frontend only; the API and database are not publicly deployed |
| Admin Preview Mode (local mock data) | ✅ | Development-only tool, never in production builds ([admin-preview.md](admin-preview.md)) |

## Remaining Work

Unfinished requirements (🟡 and ❌), grouped by module. IDs refer to the tables above.

### Authentication & Authorization (4 remaining)

- **#2** Staff (Employee, HR, Admin) sign in with Google (§2, §9) (🟡 partial)
- **#5** Trainee registration and sign-in by email only: one-time link or code, no password (§2, §4, §9) (🟡 partial)
- **#7** Role-based permissions on the API (§2 matrix, §9) (🟡 partial)
- **#8** Trainees never see each other; a trainee can access only their own data (§2, §9 Security) (🟡 partial)

### Admin (3 remaining)

- **#14** View accepted trainees (§2 matrix: Admin ✔) (❌ deferred)
- **#15** Reports: all (§2 matrix, §6) (❌ deferred)

### Trainee (5 remaining)

- **#16** Submit a training application: name, phone, university, major, study year, field, available period, hours, mandatory-for-university (§4 Trainee, §3 step 1) (❌ deferred)
- **#17** Upload CV and any university letter (§4 Trainee) (❌ deferred)
- **#18** Status board: where my application is, without seeing other trainees (§4 Trainee) (❌ deferred)
- **#19** Certificate: publish the page or keep it private; print or download as PDF (§4 Trainee, §5) (❌ deferred)
- **#20** Apply again later (e.g. another field); every training stays on record (§4 Trainee) (❌ deferred)

### Employee (4 remaining)

- **#21** Available trainees list (accepted, unassigned), filterable by field, university and period, with CV view (§4 Employee) (❌ deferred)
- **#22** "I want to train them" request with a short note, then wait for HR approval (§4 Employee, §3 step 5) (❌ deferred)
- **#23** My trainees (current and past) with periodic progress notes during training (§4 Employee) (❌ deferred)
- **#24** Final evaluation of own trainees only: score per Admin criterion, comment, hiring recommendation Yes/Maybe/No (§4 Employee, §2, §3 step 8) (❌ deferred)

### HR (8 remaining)

- **#25** New applications inbox: review, then accept, or reject with a reason (§4 HR, §3 steps 2–3) (❌ deferred)
- **#26** Contact log: record every call or verbal agreement (date, method, summary) (§4 HR, §8 ContactLog) (❌ deferred)
- **#27** Mentor requests: see every request, approve after coordination and set start/end dates; rejection returns the trainee to the list (§4 HR, §3 step 6) (❌ deferred)
- **#28** Training starts only after two HR decisions: accept the application, then approve the assignment (§3) (❌ deferred)
- **#29** Direct assignment of a trainee to an employee without a request (§4 HR) (❌ deferred)
- **#30** Running training: extend, end early, transfer to another employee, record withdrawal, always with the reason (§4 HR, §3 step 7) (❌ deferred)
- **#31** HR can evaluate (§2 matrix: Evaluate ✔ for HR) (❌ deferred)
- **#32** View accepted trainees (§2 matrix: HR ✔) (❌ deferred)

### Certificates (7 remaining)

- **#33** Each completed training generates a page with a fixed link and a random, unguessable verification code (§5) (❌ deferred)
- **#34** Page content: trainee name, field, university, period and hours, mentor name, overall grade, mentor's words (§5) (❌ deferred)
- **#35** QR code on the page and on the printed copy, opening the same page (§5) (❌ deferred)
- **#36** Official PDF with company logo and HR signature (§5) (❌ deferred)
- **#37** "Share on LinkedIn" button (§5) (❌ deferred)
- **#38** Revocation by HR: the page stays and shows the certificate as invalid (§5) (❌ deferred)
- **#39** Public page shows an overall grade only; detailed scores stay internal (§5 proposal) (❌ deferred)

### Reports (7 remaining)

- **#40** Monthly report: everyone training during the month, with whom, field, from/to (§6) (❌ deferred)
- **#41** Fields report: applications, accepted and completed per field (§6) (❌ deferred)
- **#42** Mentor profile: trainees per employee over time and average evaluation; HR, and each employee for themselves (§6) (❌ deferred)
- **#43** Hiring pipeline: trainees recommended for hiring, ranked by evaluation (§6) (❌ deferred)
- **#44** Trainee history: all trainings of one trainee and their contact notes (§6) (❌ deferred)
- **#45** Every report filterable by period, field and employee, exportable to Excel or PDF (§6) (❌ deferred)
- **#46** Monthly report based on assignment start/end dates; a transfer is recorded as two separate assignments (§6 technical note) (❌ deferred)

### Notifications (15 remaining)

- **#47** New training application → HR (email + in-app) (§7) (❌ deferred)
- **#48** Application received (confirmation) → Trainee (email) (§7) (❌ deferred)
- **#49** Application accepted or rejected → Trainee (email) (§7) (❌ deferred)
- **#50** New available trainee in your field (optional, can be muted) → Employees of the field (in-app) (§7) (❌ deferred)
- **#51** Employee requested to train a trainee → HR (email + in-app) (§7) (❌ deferred)
- **#52** Assignment approved or rejected → Employee (email + in-app) (§7) (❌ deferred)
- **#53** Assignment approved (start date and mentor details) → Trainee (email) (§7) (❌ deferred)
- **#54** Training ends soon (7 days before) → Employee and HR (in-app) (§7) (❌ deferred)
- **#55** Training ended: fill in the evaluation → Employee (email + in-app) (§7) (❌ deferred)
- **#56** Late evaluation reminder (every 3 days; HR copied after the 2nd reminder) → Employee (+HR) (email) (§7) (❌ deferred)
- **#57** Certificate ready (email with the page link) → Trainee (email) (§7) (❌ deferred)
- **#58** Request pending more than 5 days → HR (email) (§7) (❌ deferred)
- **#59** Weekly summary → HR (email) (§7) (❌ deferred)
- **#60** Sign-in link or code → Trainee (email) (§7) (🟡 partial)
- **#61** Email templates in Arabic and English (§7) (🟡 partial)

### Records & Data Integrity (1 remaining)

- **#64** Data model: Trainee, Employee, Field, Application, MentorRequest, Assignment, ProgressNote, EvaluationCriterion, Evaluation, Certificate, ContactLog, Notification, AuditLog (§8) (🟡 partial)

### Platform & Technical (8 remaining)

- **#67** One interface with role-based areas plus a lightweight public certificate page (§9) (🟡 partial)
- **#70** Cloud file storage for CVs and university letters: S3 or Azure Blob (§9) (❌ not started)
- **#71** Email delivery service: SendGrid or Amazon SES, bilingual templates (§9) (❌ not started)
- **#72** Scheduled jobs (Hangfire or similar) for reminders and the weekly summary (§9) (❌ not started)
- **#73** Server-side PDF and QR generation from an HTML template (§9) (❌ not started)
- **#74** Cloud hosting (Azure or AWS) with daily database backup (§9) (❌ not started)
- **#75** Security: files served through temporary links (§9) (❌ deferred)
- **#76** Security: application form protected with rate limiting and CAPTCHA (§9) (❌ deferred)

### Suggested order (from the dependencies above)

1. **Finish authentication setup** (configuration, not code): Google OAuth client ID and company domain, first Admin, e-mail provider ([authentication.md](authentication.md)).
2. **Trainee applications**, plus file storage for CV and letters.
3. **HR**: applications inbox, contact log, accept/reject, then mentor requests from **Employees** and assignment approval, direct assignment, running-training changes.
4. **Employee** progress notes and final evaluation.
5. **Certificates** (public page, PDF, QR, revocation), then **Reports** and export.
6. **Notifications/email** and **scheduled jobs**, wired to each module's events as it lands. Then hosting and backups.
