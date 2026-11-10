# Deferred Features: PDF features not yet complete, and why

Project-wide list of requirements-PDF features, the module or decision they wait for, and their status. Each row keeps
its ID as history. Open questions (Q, L, N, B, NEW) are in [decisions.md](decisions.md) §C–D; the full
requirement-by-requirement status is in [requirements-progress.md](requirements-progress.md).

**How to use this file**
- When a module ships or a question is answered, update the rows that list it under *Depends on* or *Why*.
- When a feature is implemented, set it to **Done** (or **Partly done**) with the date, and keep the row as history.

Status values: **Blocked** (a module, an owner decision or an external dependency is missing) · **Ready** (nothing
blocks it, not built) · **Partly done** · **Done**. Production means the Cloudflare Worker `ims-api` and Pages
`progineer-ims` ([deployment.md](deployment.md)).

## Modules (state 2026-11-04; e-mail rows updated 2026-11-10)

| Module | PDF reference | State |
|---|---|---|
| Admin | §2, §4 Admin | **Built, in production**: fields, evaluation criteria and weights, users and roles, notification intervals, certificate template (AD-43), accepted trainees, reports (monthly, fields), audit log viewer (AD-51) |
| Authentication: staff (Google, staff domains) | §2, §9 | **Built, in production** (AD-42, AD-44, AD-45, AD-46) |
| Authentication: trainee (passwordless e-mail link/code, 15 min) | §2, §4 Trainee, §9 | **Built, in production**: verified by the owner on 2026-11-10 (e-mail through Gmail SMTP, AD-58) |
| Trainee: applications | §3 steps 1–4, §4 Trainee | **Built, in production** (AD-47, AD-48) |
| HR: applications, contact log, mentor requests | §3 steps 2–6, §4 HR | **Built, in production** (AD-47, AD-49); direct assignment and the running-training actions are not built |
| Employee: mentoring and progress notes | §3 steps 4–5, §4 Employee | **Built, in production**; the final evaluation is not built |
| Final evaluation | §3 step 8, §4 Employee, §8 | **Not built** (owner decisions, D-33) |
| Certificates: public page, PDF, QR | §3 step 9, §5 | **Not built** (template settings only, AD-43) |
| Reports and export | §6 | **Partly built, in production**: monthly, fields (no completed count), mentor profile (no average), trainee history; filters where defined. Hiring pipeline not built. Excel/PDF export: see D-45 |
| Notifications (in-app) | §7 | **Partly built, in production** (AD-50): four in-app events |
| E-mail | §7, §9 | **Transport operational, in production**: Gmail SMTP with Nodemailer (AD-58, replaces the planned SendGrid integration of AD-53), verified on 2026-11-10 with the trainee sign-in e-mail. Not built: the event e-mails, bilingual templates and scheduled reminders (D-50 to D-53) |
| File storage (CVs, university letters) | §4 Trainee, §9 | **Built, in production**: private Cloudflare R2, temporary links (AD-48) |
| Scheduled jobs (reminders, weekly summary) | §7, §9 | **Not built** (needs the decisions in D-51, D-52) |

## Deferred features

### Admin

| ID | Feature (PDF) | Depends on | Why | Status |
|---|---|---|---|---|
| D-01 | Using the Admin pages in the browser (PDF §2: Admin signs in with Google) | Authentication: staff | — | **Done** (in production) |
| D-02 | Staff accounts listed in *Users and roles* (a new account from a staff domain is created automatically as Employee) | Authentication: staff | — | **Done** (2026-10-26) |
| D-03 | View accepted trainees (PDF §2 matrix: Admin ✔) | Trainee and HR applications | — | **Done** (deployed 2026-11-02): read-only; the trainee's basic profile, requested period and recorded assignments; no e-mail, phone or CV (C5) |
| D-04 | Reports for the Admin (PDF §2 matrix: Admin «الكل»; §6 table: monthly and fields reports) | Reports | Which reports the Admin sees beyond the §6 table is open (NEW-02) | **Partly done**: monthly and fields reports (deployed 2026-11-03) |
| D-05 | Audit log viewer (PDF §5 «سجل التغييرات»; access: owner decision AD-51) | Audit log (database triggers) | — | **Done** (deployed 2026-11-03): read-only, safe metadata only, actor names; sign-in writes attributed to the verified user (deployed 2026-11-03) |

### Trainee

| ID | Feature (PDF) | Depends on | Why | Status |
|---|---|---|---|---|
| D-10 | Register and sign in with e-mail only, by link or code | Authentication: trainee; e-mail | — (was blocked by the e-mail provider until 2026-11-10) | **Done** (in production; the sign-in e-mail is sent through Gmail SMTP, AD-58; verified by the owner on 2026-11-10: e-mail received, code accepted, trainee signed in) |
| D-11 | Application form (name, phone, university, major, study year, field, period, hours, mandatory flag) | — | Form rules are implementation choices pending confirmation (Q35) | **Done** (in production by 2026-10-29) |
| D-12 | Upload CV and university letter | File storage | — | **Done** (in production; private R2, temporary links) |
| D-13 | Status board: where my application is, without seeing other trainees | — | After acceptance the board shows nothing more (L10); the rejection e-mail is not built (event e-mails, D-50) | **Partly done** (in production): the application status, and for a rejected application the reason HR recorded (AD-61, Q36, NEW-25; deployed 2026-11-10, Worker `3f953830`, Pages `ff7586bf`; production visual verification pending a legitimate rejected application) |
| D-14 | Publish or keep private, print and download my certificate as PDF | Certificates | Certificates are not built | **Blocked** |
| D-15 | Apply again later; every training stays on record | — | Several open applications at once is open (Q16) | **Done** (in production) |

### HR

| ID | Feature (PDF) | Depends on | Why | Status |
|---|---|---|---|---|
| D-20 | New-applications inbox: review, accept, or reject with a reason | — | — | **Done** (in production) |
| D-21 | Contact log for calls and verbal agreements (date, method, summary) | — | Editing entries is open (Q37) | **Done** (in production) |
| D-22 | Mentor requests: approve after coordination and set start/end dates, or reject | — | Other pending requests for the same trainee (Q38) | **Done** (in production) |
| D-23 | Direct assignment of a trainee to an employee | — | Owner decisions Q38, L5 | **Blocked** (decisions) |
| D-24 | Running training: extend, end early, transfer, record withdrawal (with reason) | Assignments (built) | Owner decisions L1–L5, L8, L9. The read-only HR list of trainings (current and previous) is in production (2026-11-02) | **Blocked** (decisions) |
| D-25 | Reports and export (all reports) | — | See D-40–D-45 | **Partly done** |
| D-26 | Revoke a certificate (page stays and shows invalid) | Certificates | — | **Blocked** |

### Employee

| ID | Feature (PDF) | Depends on | Why | Status |
|---|---|---|---|---|
| D-30 | Available trainees list, filterable by field, university and period, with CV view | — | — | **Done** (in production) |
| D-31 | "I want to train them" request with a short note | — | A cap per employee is open (Q5) | **Done** (in production) |
| D-32 | My trainees (current and past), with periodic progress notes | — | Notes of previous trainees not shown (B2); editing and readers (Q37); note date (Q40); notes only while Active (B5); after a transfer (L5); text rules (B7); access after a role change (B8) | **Partly done** (in production since 2026-10-29): the employee's own assignments; notes on their Active ones (author, time of saving, text); never deleted; audited |
| D-33 | Final evaluation: score per criterion, comment, hiring recommendation | — | Owner decisions Q3 (criteria list from HR), N1–N7, Q11, Q13, L6 | **Blocked** (decisions) |
| D-34 | Own mentor profile report | — | Average evaluation (N2, Q11, NEW-03); "over time" (NEW-13) | **Partly done** (deployed 2026-11-03): the employee's own trainees and assignments |

### Certificates

| ID | Feature (PDF) | Depends on | Why | Status |
|---|---|---|---|---|
| D-35 | Public certificate page with fixed link and verification code (`/c/<code>`) | Final evaluation (D-33) | Owner decisions L1, L7, Q2, Q4, Q11; the domain (Q10) | **Blocked** |
| D-36 | QR code on the page and the printed copy, official PDF | D-35 | Also Q8 (signature) | **Blocked** |
| D-37 | Share on LinkedIn button | D-35 | — | **Blocked** |

### Reports and export

| ID | Feature (PDF) | Depends on | Why | Status |
|---|---|---|---|---|
| D-40 | Monthly report: who trained during the month, with whom, field, from/to | — | — | **Done** (deployed 2026-11-03): HR and Admin. Every assignment whose recorded dates overlap the month (both days included), whatever its status; a transferred trainee is one row per assignment. Filters: month and year, field, employee |
| D-41 | Fields report: applications, accepted and completed per field | — | Completed count waits for L1; the period and employee filters for NEW-12 | **Partly done** (deployed 2026-11-03): HR and Admin. Every field, with applications (every status) and Accepted applications; field filter |
| D-42 | Mentor profile: trainees per employee over time and average evaluation | — | Average: N2, Q11, NEW-03; "over time": NEW-13; Admin access: NEW-02 | **Partly done** (deployed 2026-11-03): HR (every employee) and each employee (own). Distinct trainees and assignment records over every stored status (owner approval 2026-11-03). HR employee filter (RN-1, deployed 2026-11-04; the owner verified the "No matching employees" empty state in production, the other scenarios not yet confirmed) |
| D-43 | Hiring pipeline: trainees recommended for hiring, ranked by evaluation | Final evaluation | NEW-03, N2, Q11 | **Blocked** |
| D-44 | Trainee history: all trainings and contact notes of one trainee | — | Employee filter: NEW-14 | **Done** (deployed 2026-11-02; filters 2026-11-03): HR; trainees with at least one Accepted application; period and field filters on the trainings, offered from two trainings on; contact notes always complete |
| D-45 | Filter by period, field and employee, and export to Excel or PDF | D-40–D-44 | Filters built where their meaning is defined (monthly: month, field, employee; fields: field; trainee history: period, field; mentor profile: employee, HR only, deployed 2026-11-04) | **Partly done**: filters as listed. Excel and PDF export of the four built reports: **done** (deployed 2026-11-04, Pages `c81d55dc`; verified in production by the owner, AD-55) |

### Notifications and e-mail

| ID | Feature (PDF §7) | Depends on | Why | Status |
|---|---|---|---|---|
| D-50 | Event e-mails and in-app notifications | The modules that raise each event; e-mail | No event e-mail is built yet (the transport works: Gmail SMTP, AD-58); "new trainee in your field" (Q14); 7-day and training-ended (lifecycle, scheduling, NEW-09); channels settled (Q42 answered 2026-11-10, AD-59: the PDF table exactly); delivery, retries and the Admin failed-e-mail page decided (AD-60); open NEW-19 to NEW-25, NEW-29, NEW-30; the "email status" field | **Partly done** (deployed 2026-11-02, AD-50): in-app new application → HR, mentor request → HR, assignment approved / rejected → the employee; HR and Employee only; every HR member gets their own copy (owner, 2026-11-02) |
| D-51 | Timed reminders using the Admin intervals: training ending in 7 days, late evaluation every 3 days, request pending more than 5 days | Scheduled jobs; lifecycle; evaluation | NEW-06, L1, N3 (NEW-05 and NEW-09 answered 2026-11-10: AD-61, AD-62); no scheduled jobs yet (the e-mail transport is available, AD-58) | **Blocked** (decisions; the intervals are stored). The pending-request reminder is decided (AD-61; open NEW-22, NEW-24, NEW-26, NEW-31) but not built |
| D-52 | Weekly summary to HR | Scheduled jobs; e-mail | NEW-04 partly answered (AD-62: Thursday 09:00 Asia/Hebron, categories, window); NEW-27, NEW-28, NEW-31, L1; no scheduled jobs yet (the e-mail transport is available, AD-58) | **Blocked** (decisions NEW-27, NEW-28; lifecycle) |
| D-53 | Bilingual (Arabic/English) e-mail templates | E-mail | NEW-07 and NEW-01 answered 2026-11-10 (AD-60: HTML with a plain-text alternative, Arabic first then English in one message, sender name ProGineer); templates of the event e-mails come with D-50 | **Partly done**: the bilingual HTML layout (Arabic first, then English, with an equivalent plain text, sender ProGineer) exists and is used by the only e-mail, the trainee sign-in e-mail (deployed 2026-11-10, Worker `7ae6b96c`; verified in production by the owner on 2026-11-10). No event e-mail templates yet |

## Dependency order

```
Authentication (staff, trainee) ─► Trainee: applications (+ R2 files) ─► HR: applications & contact log
        ─► Employee: mentor requests ─► HR: assignment ─► Employee: progress notes        (built)
        ─► Running training (L-decisions) ─► Final evaluation (N-decisions, Q3) ─► Certificates ─► remaining reports
E-mail transport: Gmail SMTP (AD-58, operational since 2026-11-10). Event e-mails and scheduled jobs follow each module whose events they report.
```
