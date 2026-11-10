# Requirements Progress

Every requirement of the original requirements PDF (*خطة نظام إدارة المتدربين*, 22 Oct 2026, the source of truth) and
the owner-approved decisions, against the **actual code and production**. Last verified: **2026-11-04**, `main` @
`72614eb`, Worker `aaa13c87`, Pages `11ae7ac8`, Neon `ims_db` with 8 migrations (read-only checks). Updated for the
report export: `main` @ `6903209`, Pages `c81d55dc` (Worker and database unchanged). Updated for the security release:
`main` @ `8f005fa`, Worker `6c144b0b` (Pages and database unchanged). Updated for RN-1 (HR mentor profile employee
filter): `main` @ `eaf01fe`, Worker `92b6c658`, Pages `528f0cb3` (database unchanged). Updated for Admin role governance
(AD-56): `main` @ `316f6ac`, Worker `6900a9e2`, Pages `0551650d` (database unchanged). Updated for the audit log
descriptions (AD-57): `main` @ `cb2b215`, Worker `61ea9041`, Pages `94081d2f` (database unchanged). Updated for Gmail SMTP (AD-58):
`main` @ `65355e6`, Worker `273dc51a` (Pages and database unchanged); trainee e-mail sign-in verified in production by the
owner on 2026-11-10. The earlier snapshot
(2026-10-27) is in Git history.

**Status:** ✅ Complete · 🟡 Partial (part of the required behaviour is missing) · ❌ Not implemented · ⏸ Deferred by
the owner · 🔒 Blocked by an external dependency (built where possible). "Prod" = in production. Question IDs are in
[decisions.md](decisions.md) §C–D; `D-xx` in [deferred-features.md](deferred-features.md).

## Summary

| Status | Count |
|---|---|
| ✅ Complete | 30 |
| 🟡 Partial | 8 |
| ❌ Not implemented | 19 |
| ⏸ Deferred by the owner | 3 |
| 🔒 Blocked by an external dependency | 1 |
| **Total** | **61** |

The core of PDF §3 (apply → review and contact → accept/reject → available → mentor request → assignment → progress
notes) is complete and in production. The final evaluation, certificates, the running-training actions, the hiring
report, scheduled reminders and the event e-mails are not, almost all because of open owner decisions. Trainee e-mail
sign-in works in production through Gmail SMTP (AD-58, verified 2026-11-10).

## Authentication, roles, isolation

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R01 | Staff sign in with Google, company domains only; new accounts are Employees (p.1) | ✅ | Yes | AD-42, AD-45, AD-46 |
| R02 | Higher roles granted by the Admin only (p.1) | ✅ | Yes | Role changes audited |
| R03 | Trainees sign in by e-mail link or one-time code, 15 minutes (p.1, p.2, p.5) | ✅ | Yes | E-mail through Gmail SMTP (AD-58); **verified in production by the owner on 2026-11-10** (e-mail received, code accepted, trainee signed in; Worker `273dc51a`). The e-mailed link uses the same records and expiry |
| R04 | Trainees never see one another (p.1) | ✅ | Yes | Isolation tests |
| R05 | Persistent server-side sessions, revocable (AD-44) | ✅ | Yes | Sign-in writes attributed to the verified user |

## Admin

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R06 | Fields: add, edit, activate/deactivate (p.2, p.4) | ✅ | Yes | |
| R07 | Evaluation criteria and weights (p.2, p.4) | ✅ | Yes | Configuration only; the real list is open (Q3); retiring a criterion (Q31) |
| R08 | Users and roles (p.2) | ✅ | Yes | Admin governance (AD-56): no self-change of role, never zero Admins, safe under simultaneous changes |
| R09 | Certificate template (p.2) | ✅ | Yes | Settings (AD-43); certificates are not built |
| R10 | Admin-changeable 7/3/5-day intervals (p.4) | ✅ | Yes | Stored; used by no reminder yet (R47) |
| R11 | The Admin sees the accepted trainees (p.1) | ✅ | Yes | No e-mail, phone or CV (C5) |
| R12 | Admin reports «الكل» (p.1) vs the §6 table | 🟡 | Yes | Monthly and fields only (NEW-02) |

## Trainee

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R13 | Application form with CV and university letter (p.2) | ✅ | Yes | Rules pending confirmation (Q35); files in R2 (AD-48) |
| R14 | Status board (p.2) | 🟡 | Yes | Application status only (L10, Q36) |
| R15 | Apply again later; every training stays on record (p.2) | ✅ | Yes | Concurrent applications (Q16) |
| R16 | Publish or hide, print and download the certificate as PDF (p.2, p.3) | ❌ | — | Needs certificates |

## HR

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R17 | Inbox, review and contact log (date, method, summary) (p.2) | ✅ | Yes | Editing open (Q37) |
| R18 | Accept, or reject with a reason; rejected kept (p.2) | ✅ | Yes | Reason visibility (Q36) |
| R19 | Mentor requests: approve with dates, or reject (the trainee returns to the list) (p.2) | ✅ | Yes | Other pending requests (Q38) |
| R20 | Direct assignment (p.2) | ❌ | — | Q38, L5 |
| R21 | Running training: extend, end early, transfer, withdraw, with a reason (p.2) | ❌ | — | L2–L5, L8, L9 |
| R22 | Trainings list, current and previous (read-only, supports p.2) | ✅ | Yes | |

## Employee

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R24 | Available trainees filtered by field, university and period, with the CV (p.2) | ✅ | Yes | |
| R25 | "I want to train them" request with a note (p.2) | ✅ | Yes | Cap per employee (Q5) |
| R26 | My trainees, current and previous, with periodic notes (p.2) | 🟡 | Yes | B2, B5, B7, B8, Q37, Q40, L5 |
| R27 | Final evaluation: score per criterion, comment, hiring recommendation; total and grade (p.2, p.4) | ❌ | — | Q3, N1–N7, Q11, Q13, L6 |
| R28 | Automatic evaluation reminder (p.2 step 8) | ❌ | — | L1, N3, NEW-06; scheduler; e-mail |

## Certificates (p.3)

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R29 | A certificate per completed training: fixed link, random code, content (p.3, p.4) | ❌ | — | L1, L7, Q2, Q4, Q11, N2; domain Q10 |
| R31 | QR code on the page and the printout | ❌ | — | With R29 |
| R32 | Official PDF with the logo and HR signature, rendered on the server (p.3, p.5) | ❌ | — | With R29; Q8 |
| R33 | Share on LinkedIn | ❌ | — | With R29 |
| R34 | Revocation: the page stays and shows "invalid" | ❌ | — | With R29 |

## Records and audit

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R35 | Nothing is deleted; changes are status changes (p.3, p.4) | ✅ | Yes | DELETE/TRUNCATE refused by triggers on every table; a catalog test checks every table |
| R36 | Every action recorded with who and when (p.3, p.5) | ✅ | Yes | Database triggers; actor from the verified session; behaviour tests for the main writes |
| R37 | Audit log viewer (AD-51) | ✅ | Yes | Admin only; metadata only; actor names; a description of every entry in Arabic and English, historical ones included (AD-57) |
| R65 | Least-privilege database role for the Worker (AD-52) | ✅ | Yes | `ims_app`; limits in [least-privilege.md](least-privilege.md) |

## Reports (p.3)

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R38 | Monthly report (HR, Admin) | ✅ | Yes | Month, field, employee filters |
| R39 | Fields report (HR, Admin) | 🟡 | Yes | No completed count (L1); filters NEW-12 |
| R40 | Mentor profile (HR; each employee for themself) | 🟡 | Yes | HR employee filter (RN-1, 2026-11-04). No average (N2, Q11, NEW-03), no "over time" (NEW-13) |
| R41 | Hiring pipeline (HR) | ❌ | — | Needs evaluations; NEW-03 |
| R42 | Trainee history (HR) | ✅ | Yes | Period and field filters; employee filter NEW-14 |
| R43 | Every report filtered by period, field and employee | 🟡 | Yes | Where the meaning is defined (mentor profile: employee, HR, 2026-11-04) |
| R44 | Export every report to Excel or PDF | ✅ | Yes | Excel and PDF for the four built reports (AD-55); deployed 2026-11-04 and verified in production by the owner. The hiring pipeline (R41) is not built yet; its export comes with it |

## Notifications and e-mail (p.3–4)

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R45 | In-app notifications | 🟡 | Yes | 4 of the in-app events (AD-50); Q14, lifecycle, scheduler |
| R46 | E-mail events and bilingual templates | ❌ | — | The provider works (Gmail SMTP, AD-58; the sign-in e-mail is R03), but the event e-mails of PDF §7 are not built and the templates are not bilingual (the sign-in e-mail has a bilingual subject, an English body): NEW-01 display name, NEW-07, Q42, Q36 |
| R47 | Timed reminders (7 days, late evaluation every 3 days, pending > 5 days) | ❌ | — | NEW-05, NEW-06, NEW-09, L1, N3; scheduler; e-mail |
| R48 | Weekly summary to HR | ❌ | — | NEW-04; e-mail |
| R50 | Notification "email status" field (p.4) | ❌ | — | Q42; e-mail |

## Data, platform and security

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R51 | Employee department (p.4) | 🟡 | Yes | Column exists, never set (Q32) |
| R52 | Responsive Arabic (RTL) and English interface (p.5) | ✅ | Yes | React (AD-34) |
| R53 | A trainee reaches only their own data (p.5) | ✅ | Yes | |
| R54 | Private files served through temporary links (p.5) | ✅ | Yes | R2, 5-minute signed links (AD-48) |
| R55 | Rate limiting on the application form (p.5) | ✅ | Yes | Also on trainee sign-in; the 429 says `Retry-After: 60` |
| R56 | CAPTCHA on the application form (p.5) | ❌ | — | Q22; provider keys |
| R57 | Scheduled jobs (p.5) | ❌ | — | Needed by R28, R47, R48 |
| R58 | Daily database backup (p.5) | ⏸ | — | Deferred until development is complete (AD-54); Neon restore window 6 hours |
| R59 | Domain and system name (p.6, Q10) | 🔒 | — | Hosting decided (Cloudflare); domain and DNS open |
| R60 | Attendance or hours tracking (p.6, Q6) | ⏸ | — | Paused |
| R61 | University forms to print (p.6, Q7) | ❌ | — | May not be needed (Q7) |
| R62 | Import of past trainees (p.6, Q9) | ❌ | — | Q9 |
| R64 | HR ownership of individual trainees (owner, 2026-11-02) | ⏸ | — | NEW-10 |

R23, R30, R49 and R63 of the audit were merged into the rows above.
