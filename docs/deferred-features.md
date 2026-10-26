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
| Admin | §2, §4 Admin | **Partly built**: fields, evaluation criteria and weights, users and roles, notification intervals |
| Authentication: staff (Google OAuth, company domain) | §2, §9 | Not built (cookie scheme and role policies are wired; no sign-in) |
| Authentication: trainee (passwordless email link/code, 15 min) | §2, §4 Trainee, §9 | Not built |
| Trainee: applications | §3 steps 1–4, §4 Trainee | Not built |
| HR: applications, contact log, assignment | §3 steps 2–7, §4 HR | Not built |
| Employee: mentoring and evaluation | §3 steps 5, 8, §4 Employee | Not built |
| Certificates: public page, PDF, QR | §3 step 9, §5 | Not built |
| Reports and export | §6 | Not built |
| Notifications and email | §7 | Not built (only the Admin intervals are stored) |
| File storage (CVs, university letters) | §4 Trainee, §9 | Not built |
| Scheduled jobs (reminders, weekly summary) | §7, §9 | Not built |

## Deferred features

### Admin

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-01 | Using the Admin pages in the browser (PDF §2: Admin signs in with Google) | Authentication: staff | Every Admin API call requires a signed-in user with the Admin role. Without sign-in, the pages receive 401 | Blocked |
| D-02 | Staff accounts listed in *Users and roles* (PDF §2: a new account from the company domain is created automatically as Employee) | Authentication: staff | Employee records are created on first Google sign-in, which does not exist yet. The Admin can only manage the roles of existing accounts | Blocked |
| D-03 | View accepted trainees (PDF §2 matrix: Admin ✔) | Trainee: applications; HR: applications | There are no applications, and no HR accept decision to filter on | Blocked |
| D-04 | Reports: all (PDF §2 matrix: Admin "all"; §6 monthly and fields reports for Admin) | Reports and export (which needs Trainee, HR and Employee data) | The reports read applications, assignments and evaluations, none of which exist | Blocked |

### Trainee

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-10 | Register and sign in with email only, by link or code | Authentication: trainee; Notifications and email | The sign-in link/code must be emailed (§7 "sign-in link or code") | Blocked |
| D-11 | Application form (name, phone, university, major, study year, field, period, hours, mandatory flag) | Authentication: trainee | The form belongs to the signed-in trainee's account (§3 step 1). Fields come from Admin (available) | Blocked |
| D-12 | Upload CV and university letter | File storage; D-11 | Files are kept in cloud storage and served through temporary links (§9) | Blocked |
| D-13 | Status board: where my application is, without seeing other trainees | D-11; HR: applications; HR: assignment | The statuses come from HR decisions and assignments | Blocked |
| D-14 | Publish or keep private, print and download my certificate as PDF | Certificates | Certificates are generated after the final evaluation | Blocked |
| D-15 | Apply again later; every training stays on record | D-11 | Requires applications | Blocked |

### HR

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-20 | New-applications inbox: review, accept, or reject with a reason | Trainee: applications; Authentication: staff | Nothing to review until trainees can apply | Blocked |
| D-21 | Contact log for calls and verbal agreements (date, method, summary) | Trainee: applications | Every log entry belongs to an application | Blocked |
| D-22 | Mentor requests: approve after coordination and set start/end dates | Employee: mentoring (requests) | Requests are created by employees | Blocked |
| D-23 | Direct assignment of a trainee to an employee | D-20 (accepted applications); Authentication: staff (employee accounts) | Needs accepted trainees and employees | Blocked |
| D-24 | Running training: extend, end early, transfer, record withdrawal (with reason) | D-22 or D-23 (assignments) | Operates on active assignments | Blocked |
| D-25 | Reports and export (all reports) | Reports and export | See D-40–D-45 | Blocked |
| D-26 | Revoke a certificate (page stays and shows invalid) | Certificates | No certificates yet | Blocked |

### Employee

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-30 | Available trainees list, filterable by field, university and period, with CV view | HR: applications (accepted); File storage (CV) | Lists accepted, unassigned trainees. Fields come from Admin (available) | Blocked |
| D-31 | "I want to train them" request with a short note | D-30 | Requests target trainees in the available list | Blocked |
| D-32 | My trainees (current and past), with periodic progress notes | HR: assignment (D-22/D-23) | Notes belong to an assignment | Blocked |
| D-33 | Final evaluation: score per criterion, comment, hiring recommendation | D-32; HR: assignment | Evaluates an assignment. Criteria and weights come from Admin (available) | Blocked |
| D-34 | Own mentor profile report | Reports and export | §6 "mentor profile" for the employee themself | Blocked |

### Certificates

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-35 | Public certificate page with fixed link and verification code (`/c/<code>`) | Employee: evaluation (D-33) | A certificate is generated by a completed, evaluated training | Blocked |
| D-36 | QR code on the page and the printed copy, official PDF | D-35 | Generated from the certificate | Blocked |
| D-37 | Share on LinkedIn button | D-35 | Shares the public page | Blocked |

### Reports and export

| ID | Feature (PDF) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-40 | Monthly report: who trained during the month, with whom, field, from/to | HR: assignment | Built from assignment start/end dates (§6 technical note) | Blocked |
| D-41 | Fields report: applications, accepted and completed per field | Trainee: applications; HR: applications | Counts applications and their outcomes | Blocked |
| D-42 | Mentor profile: trainees per employee over time and average evaluation | HR: assignment; Employee: evaluation | Needs assignments and evaluations | Blocked |
| D-43 | Hiring pipeline: trainees recommended for hiring, ranked by evaluation | Employee: evaluation | Uses the hiring recommendation | Blocked |
| D-44 | Trainee history: all trainings and contact notes of one trainee | Trainee: applications; HR: contact log | Needs applications and contact logs | Blocked |
| D-45 | Filter by period, field and employee, and export to Excel or PDF | D-40–D-44 | Applies to the reports above | Blocked |

### Notifications and email

| ID | Feature (PDF §7) | Depends on | Why it is blocked | Status |
|---|---|---|---|---|
| D-50 | Event emails and in-app notifications (new application, received, accepted/rejected, new trainee in field, mentor request, assignment decision, assignment approved, certificate ready) | Notifications and email; the modules that raise each event (Trainee, HR, Employee, Certificates) | Each notification is triggered by an event in a module that doesn't exist yet | Blocked |
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
