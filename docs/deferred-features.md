# Deferred Features (blocked by missing modules)

Project-wide list of requirements-PDF features that **cannot be implemented yet because a module they depend on does not exist**.
Features blocked for other reasons (missing business information, vendor choices) are **not** listed here. They are in [decisions.md](decisions.md) §C–D.

**How to use this file**
- When a module ships, find the rows that list it under *Depends on*. If all of a row's dependencies now exist, set the row to **Ready**.
- When a feature is implemented, set it to **Done** with the commit or date, and keep the row as history.
- Add a row only for a feature from the requirements PDF whose blocker is a missing module.

Status values: **Blocked** (a dependency is missing) · **Ready** (dependencies exist, not built) · **Done**

## Modules

| Module | PDF reference | State (2026-10-26) |
|---|---|---|
| Admin | §2, §4 Admin | **Partly built**: fields, evaluation criteria and weights, users and roles, notification intervals, certificate template (AD-43) |
| Authentication: staff (Google OAuth, company domain) | §2, §9 | **Built**: needs the Google client ID and company domain to operate ([authentication.md](authentication.md)) |
| Authentication: trainee (passwordless email link/code, 15 min) | §2, §4 Trainee, §9 | **Built**: real e-mail delivery needs an e-mail provider; in Development codes go to the API log |
| Trainee: applications | §3 steps 1–4, §4 Trainee | Not built |
| HR: applications, contact log, assignment | §3 steps 2–7, §4 HR | Not built |
| Employee: mentoring and evaluation | §3 steps 5, 8, §4 Employee | Not built |
| Certificates: public page, PDF, QR | §3 step 9, §5 | Not built |
| Reports and export | §6 | **Partly built**: trainee history (D-44) and the monthly report (D-40), both deployed; fields report without its "completed" count (D-41) and the trainee history's period and field filters, deployed 2026-11-03; no export |
| Notifications and email | §7 | Not built: the Admin intervals are stored, and an `IEmailSender` port exists with a development log sender only |
| File storage (CVs, university letters) | §4 Trainee, §9 | Not built |
| Scheduled jobs (reminders, weekly summary) | §7, §9 | Not built |

## Deferred features

### Admin

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-01 | Using the Admin pages in the browser (PDF §2: Admin signs in with Google) | Authentication: staff | Staff sign-in is built. Waiting only for **configuration**: Google client ID, company domain, first Admin (Q17), see [authentication.md](authentication.md) | Ready |
| D-02 | Staff accounts listed in *Users and roles* (PDF §2: a new account from the company domain is created automatically as Employee) | Authentication: staff | First Google sign-in creates the Employee account, and it then appears in *Users and roles* (tested) | Done (2026-10-26) |
| D-03 | View accepted trainees (PDF §2 matrix: Admin ✔) | Trainee: applications; HR: applications | — | **Done locally, not deployed** (2026-10-31): Admin › Accepted trainees, read-only: applications with status Accepted, the trainee's profile, the requested period and the assignments recorded for each |
| D-04 | Reports: all (PDF §2 matrix: Admin "all"; §6 monthly and fields reports for Admin) | Reports and export (which needs Trainee, HR and Employee data) | Monthly report done (D-40, deployed 2026-11-03). Fields report, export and any other report for the Admin are not built (which reports the Admin sees beyond the §6 table is open) | Blocked (partly done) |
| D-05 | Audit log viewer (PDF §5 «سجل التغييرات»; viewer access: owner decision AD-51) | Audit log (database triggers, built) | — | **Done** (deployed to production 2026-11-03): Admin › Audit log, read-only, safe metadata only (id, time, actor with name and current role, operation, table, record id; no stored values; no session or sign-in code ids). Filters: operation, table, actor, date range; Load More. Audit security improvements (least-privileged database role, manual-SQL convention, retention) are not part of it |

### Trainee

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-10 | Register and sign in with email only, by link or code | Authentication: trainee; Notifications and email | Built and verified (link + code, 15 min, single use). **Still blocked for production by the e-mail provider**: in Development the e-mail goes to the API log | Blocked (e-mail provider) |
| D-11 | Application form (name, phone, university, major, study year, field, period, hours, mandatory flag) | Authentication: trainee | Trainee sign-in now exists and fields come from Admin. Not built yet. The homepage *Apply* button stays disabled until then | Ready |
| D-12 | Upload CV and university letter | File storage; D-11 | Files are kept in cloud storage and served through temporary links (§9) | Blocked |
| D-13 | Status board: where my application is, without seeing other trainees | D-11; HR: applications; HR: assignment | The statuses come from HR decisions and assignments | Blocked |
| D-14 | Publish or keep private, print and download my certificate as PDF | Certificates | Certificates are generated after the final evaluation | Blocked |
| D-15 | Apply again later; every training stays on record | D-11 | Requires applications | Blocked |

### HR

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-20 | New-applications inbox: review, accept, or reject with a reason | Trainee: applications | Nothing to review until trainees can apply (staff sign-in now exists) | Blocked |
| D-21 | Contact log for calls and verbal agreements (date, method, summary) | Trainee: applications | Every log entry belongs to an application | Blocked |
| D-22 | Mentor requests: approve after coordination and set start/end dates | Employee: mentoring (requests) | Requests are created by employees | Blocked |
| D-23 | Direct assignment of a trainee to an employee | D-20 (accepted applications); Authentication: staff (employee accounts) | Needs accepted trainees and employees | Blocked |
| D-24 | Running training: extend, end early, transfer, record withdrawal (with reason) | D-22 or D-23 (assignments) | Operates on active assignments. The read-only HR list of trainings (current and previous) exists locally, not deployed (2026-10-31) | Blocked (L1–L11) |
| D-25 | Reports and export (all reports) | Reports and export | See D-40–D-45 | Blocked |
| D-26 | Revoke a certificate (page stays and shows invalid) | Certificates | No certificates yet | Blocked |

### Employee

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-30 | Available trainees list, filterable by field, university and period, with CV view | HR: applications (accepted); File storage (CV) | Lists accepted, unassigned trainees. Fields come from Admin (available) | Blocked |
| D-31 | "I want to train them" request with a short note | D-30 | Requests target trainees in the available list | Blocked |
| D-32 | My trainees (current and past), with periodic progress notes | HR: assignment (D-22/D-23) | Notes belong to an assignment | **Done** (core, deployed to production 2026-10-29, Worker API): the employee lists their own assignments and writes and reads notes on their own Active ones (assignment, author, time of saving, text); no deletion; audited by the database. Notes of previous trainees are not shown in the web app yet. Still open, not owner-approved: editing and who else reads notes (Q37), the note date (Q40), notes only while Active (AD-49), notes of previous trainees in the web app, notes after a transfer, text rules (required, 4000 characters), and access after an Employee is given another role |
| D-33 | Final evaluation: score per criterion, comment, hiring recommendation | D-32; HR: assignment | Evaluates an assignment. Criteria and weights come from Admin (available) | Blocked |
| D-34 | Own mentor profile report | Reports and export | The average evaluation waits for evaluations (N1, N2, Q11, NEW-03) | **Partly done** (deployed to production 2026-11-03): Employee › My reports › Mentor profile, their own only (identified by the session): trainees and training assignments, as in D-42. Not built: average evaluation, breakdown over time |

### Certificates

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-35 | Public certificate page with fixed link and verification code (`/c/<code>`) | Employee: evaluation (D-33) | A certificate is generated by a completed, evaluated training | Blocked |
| D-36 | QR code on the page and the printed copy, official PDF | D-35 | Generated from the certificate | Blocked |
| D-37 | Share on LinkedIn button | D-35 | Shares the public page | Blocked |

### Reports and export

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-40 | Monthly report: who trained during the month, with whom, field, from/to | HR: assignment | — | **Done** (deployed to production 2026-11-03): HR › Reports › Monthly report and Admin › Reports › Monthly report, read-only. Every assignment whose recorded start–end dates overlap the chosen month (inclusive calendar dates), whatever its stored status; a transferred trainee shows as one row per assignment. Columns: trainee, employee, field, from, to. Filters: month and year, field, employee (§6). Export (D-45) not built |
| D-41 | Fields report: applications, accepted and completed per field | Trainee: applications; HR: applications | The "completed" count waits for when a training counts as completed (L1); the period and employee filters wait for what they mean for application counts | **Partly done** (deployed to production 2026-11-03): HR › Reports › Fields report and Admin › Reports › Fields report, read-only. For every field (also fields without applications): the number of applications (every status; a trainee with two applications counts twice) and of Accepted applications (AD-47). Field filter. The page says the completed count is not shown yet. Not built: the completed count, period and employee filters, export |
| D-42 | Mentor profile: trainees per employee over time and average evaluation | HR: assignment; Employee: evaluation | The average evaluation waits for evaluations (N1, N2, Q11, NEW-03); "over time" is not defined; Admin access is open (NEW-02) | **Partly done** (deployed to production 2026-11-03): HR › Reports › Mentor profile, read-only. Per employee (the Employee role, and anyone else who has assignments), over every stored assignment status: the number of distinct trainees (PDF «عدد من درّبهم») and of assignment records (owner approval 2026-11-03: both counts shown); zero counts included. No Admin access. Not built: average evaluation, breakdown over time, filters, export |
| D-43 | Hiring pipeline: trainees recommended for hiring, ranked by evaluation | Employee: evaluation | Uses the hiring recommendation | Blocked |
| D-44 | Trainee history: all trainings and contact notes of one trainee | Trainee: applications; HR: contact log | — | **Done** (deployed to production 2026-11-02): HR › Reports › Trainee history (PDF §6 «سجل المتدرب», a report), read-only: for a chosen trainee, all their trainings (assignments) and contact notes, as recorded. Only trainees with at least one Accepted application can be chosen, enforced by the API for the list and for direct requests (owner decision 2026-11-02). Filters on the trainings (deployed 2026-11-03): period (recorded assignment dates overlapping it, both ends included; either end optional) and field (the application's field); applications and contact notes are always shown in full. The filters are offered only when the trainee has two trainings or more in all (unfiltered total from the API); with fewer, filters in the address are dropped. Not built: an employee filter (what it would mean for contact notes is not decided) and export (D-45) |
| D-45 | Filter by period, field and employee, and export to Excel or PDF | D-40–D-44 | Filters built where their meaning is defined: monthly report (month, field, employee), fields report (field), trainee history trainings (period, field). Export not built | Blocked (export) |

### Notifications and email

| ID | Feature (PDF §7) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-50 | Event emails and in-app notifications (new application, received, accepted/rejected, new trainee in field, mentor request, assignment decision, assignment approved, certificate ready) | Notifications and email; the modules that raise each event (Trainee, HR, Employee, Certificates) | The remaining notifications wait for e-mail delivery, the training lifecycle, scheduled jobs or Q14 | **Partly done locally, not deployed** (2026-10-31, AD-50): in-app notifications for the four PDF §7 in-app events whose workflow exists (new application → HR; mentor request → HR; assignment approved / rejected → the employee), with "load more" pages, for HR and Employee only (owner decisions C2–C5). Deployment blocked by Q41 (C1, HR distribution); channel question Q42 open. Not built: every e-mail, the in-app events "new trainee in your field" (Q14), "training ending in 7 days" and "training ended" (lifecycle and scheduling), and the Notification "email status" field |
| D-51 | Timed reminders using the Admin intervals: training ending in 7 days, late evaluation every 3 days, request pending more than 5 days | Scheduled jobs; HR: assignment; Employee: evaluation; Employee: mentoring | The intervals are stored (Admin, done). What they apply to does not exist yet | Blocked |
| D-52 | Weekly summary to HR | Scheduled jobs; HR and Trainee modules | Summarises activity from those modules | Blocked |
| D-53 | Bilingual (Arabic/English) email templates | Notifications and email | No email delivery yet | Blocked |

## Dependency order (build sequence implied by the rows above)

```
Authentication (staff, trainee) ─► Trainee: applications (+ File storage) ─► HR: applications & contact log
        ─► Employee: mentor requests ─► HR: assignment ─► Employee: progress notes & evaluation
        ─► Certificates ─► Reports and export
Notifications/email and Scheduled jobs follow each module whose events they report.
```
