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
owner on 2026-11-10. Aligned on 2026-11-16 with the approved decisions and production: `main` @ `c583140`, Worker `c007ee03`, Pages `b516b290`, Neon `ims_db` with 14 migrations (read-only checks). Updated for S1 (R07 evaluation criteria, 2026-11-18): `main` @ `09bab76`, Worker `15915bde`, Pages `f572ac59`, Neon `ims_db` with 17 migrations; accepted by the owner in production. The earlier snapshot
(2026-10-27) is in Git history.

**Status:** ✅ Complete · 🟡 Partial (part of the required behaviour is missing) · ❌ Not implemented · ⏸ Deferred by
the owner · 🔒 Blocked by an external dependency (built where possible) · ➖ Out of scope (owner decision). "Prod" = in production. Question IDs are in
[decisions.md](decisions.md) §C–D; `D-xx` in [deferred-features.md](deferred-features.md).

## Summary

| Status | Count |
|---|---|
| ✅ Complete | 32 |
| 🟡 Partial | 12 |
| ❌ Not implemented | 13 |
| ⏸ Deferred by the owner | 2 |
| 🔒 Blocked by an external dependency | 1 |
| ➖ Out of scope (owner decision) | 1 |
| **Total** | **61** |

The core of PDF §3 (apply → review and contact → accept/reject → available → mentor request → assignment → progress
notes) is complete and in production. In production as well: the running-training actions except the return to Active (AD-63, AD-65), the event e-mails of the
existing workflows, and the pending-request reminder (NEW-05). Not built: the final evaluation (decided, AD-66), certificates,
the hiring report, the other scheduled reminders and the weekly summary. Trainee e-mail
sign-in works in production through Gmail SMTP (AD-58, verified 2026-11-10).

## Authentication, roles, isolation

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R01 | Staff sign in with Google, company domains only; new accounts are Employees (p.1) | ✅ | Yes | AD-42, AD-45, AD-46 |
| R02 | Higher roles granted by the Admin only (p.1) | ✅ | Yes | Role changes audited |
| R03 | Trainees sign in by e-mail link or one-time code, 15 minutes (p.1, p.2, p.5) | ✅ | Yes | E-mail through Gmail SMTP (AD-58); **verified in production by the owner on 2026-11-10** (e-mail received, code accepted, trainee signed in; Worker `273dc51a`). The e-mailed link uses the same records and expiry. An existing trainee may also sign in with Google using the same verified non-staff e-mail (AD-42 B1, in production since 2026-11-12; live Google sign-in by a trainee in production pending the owner's verification); registration is still by e-mail |
| R04 | Trainees never see one another (p.1) | ✅ | Yes | Isolation tests |
| R05 | Persistent server-side sessions, revocable (AD-44) | ✅ | Yes | Sign-in writes attributed to the verified user |

## Admin

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R06 | Fields: add, edit, activate/deactivate (p.2, p.4) | ✅ | Yes | |
| R07 | Evaluation criteria and weights (p.2, p.4) | ✅ | Yes | **In production since 2026-11-18 and accepted by the owner** (S1, release `09bab76`): the AD-66 model, with an Arabic and an English name (both required), an order assigned automatically at creation and never changed (AD-68 G7; no manual ordering), an active flag and **no weights** (every active criterion counts equally; AD-66 supersedes the PDF's weights). Neon migrations `EvaluationCriteriaBilingual`, `EvaluationCriteriaSortOrderPositive` and `EvaluationCriteriaAutomaticOrder` (14 → 17): the three production criteria kept their ids and Arabic names, received the owner's English names (AD-68 G1) and the orders Punctuality 1, Timely Task Completion 2, Attendance and Absence 3. Worker `15915bde`, Pages `f572ac59`. The real list stays the Admin's (Q3 answered by AD-66) |
| R08 | Users and roles (p.2) | ✅ | Yes | Admin governance (AD-56): no self-change of role, never zero Admins, safe under simultaneous changes |
| R09 | Certificate template (p.2) | ✅ | Yes | Settings (AD-43); certificates are not built |
| R10 | Admin-changeable 7/3/5-day intervals (p.4) | ✅ | Yes | Stored and changeable. The 5-day setting is used by the pending-request reminder (NEW-05, in production since 2026-11-15); the 7- and 3-day settings by no job yet (R47) |
| R11 | The Admin sees the accepted trainees (p.1) | ✅ | Yes | No e-mail, phone or CV (C5) |
| R12 | Admin reports «الكل» (p.1) vs the §6 table | ✅ | Yes | NEW-02 answered (owner, 2026-11-16): the Admin sees only the monthly and fields reports; production matches |

## Trainee

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R13 | Application form with CV and university letter (p.2) | ✅ | Yes | Rules pending confirmation (Q35); files in R2 (AD-48) |
| R14 | Status board (p.2) | 🟡 | Yes | Application status, and the rejection reason of a rejected application (AD-61, Q36; deployed 2026-11-10; production visual verification pending a legitimate rejected application). After acceptance: the final evaluation's verbal grade and submission date once submitted (S2.5, AD-73; **in production since 2026-11-24**, authenticated production check pending); the assignment, training and certificate are still not shown (L10) |
| R15 | Apply again later; every training stays on record (p.2) | ✅ | Yes | Concurrent applications (Q16) |
| R16 | Publish or hide, print and download the certificate as PDF (p.2, p.3) | ❌ | — | Needs certificates |

## HR

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R17 | Inbox, review and contact log (date, method, summary) (p.2) | ✅ | Yes | Editing open (Q37) |
| R18 | Accept, or reject with a reason; rejected kept (p.2) | ✅ | Yes | The trainee sees the reason on the status page (AD-61, Q36; deployed 2026-11-10; production visual verification pending a legitimate rejected application); not in an e-mail yet (R46) |
| R19 | Mentor requests: approve with dates, or reject (the trainee returns to the list) (p.2) | ✅ | Yes | Other pending requests (Q38, answered 2026-11-23, AD-49): approving one rejects the others and a second initial assignment is refused (409 `mentor_request.already_assigned`); **COMMITTED & PUSHED — NOT DEPLOYED** (commit `4948a62`) |
| R20 | Direct assignment (p.2) | ✅ | Yes The deadlock between a direct assignment and a racing approval (500) is fixed by one lock order (commit `a90bad4`, in production since 2026-11-15, Worker `c007ee03`; the loser answers 409). | In production since 2026-11-14 and tested by the owner in Production (AD-67; commit `6650090`, Worker `950d83d5`, Pages `b516b290`, migration `DirectAssignment`): the current responsible HR assigns an accepted, never-assigned trainee to an Employee with the start and planned end dates; every pending request for the trainee is rejected with a reason in the same transaction; the chosen mentor e-mail + in-app (never a rejection notice), the other requesters the ordinary rejection notices (none for a current Admin), the trainee e-mail |
| R21 | Running training: extend, end early, transfer, withdraw, with a reason (p.2) | 🟡 | Yes | In production since 2026-11-12 (Worker `ca7ec2a0`, Pages `7272d5d9`; AD-63, NEW-32): HR ends a training as Completed, Ended early (reason) or Withdrawn (reason) with the actual end date; manually tested by the owner locally, no real Production action yet. Extension in production since 2026-11-12 (Worker `422b35e8`, Pages `54722aca`; NEW-35): HR extends an Active training to a later planned end date with a mandatory reason, any number of times, every extension kept and visible to HR. Transfer in production since 2026-11-13 (Worker `beaf2d36`, Pages `0ac20f21`; AD-65, revised 2026-11-13; manually tested by the owner locally, no real Production transfer yet): the trainee's responsible HR transfers an Active training to another Employee today (at once) or schedules it for a later date (executed automatically on that date), never a past date, with a reason, and may cancel a scheduled transfer with a reason; the outgoing assignment ends the day before and stays (Transferred), the incoming one keeps the planned end date as it is on execution; every decision is kept; the latest mentor reads the earlier notes. Missing in production: return to Active (NEW-34). The final evaluation and certificate follow the ending (D1), not built |
| R22 | Trainings list, current and previous (read-only, supports p.2) | ✅ | Yes | |

## Employee

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R24 | Available trainees filtered by field, university and period, with the CV (p.2) | ✅ | Yes | |
| R25 | "I want to train them" request with a note (p.2) | ✅ | Yes | Cap per employee (Q5) |
| R26 | My trainees, current and previous, with periodic notes (p.2) | 🟡 | Yes | B2, B5, B7, B8, Q37, Q40, L5 |
| R27 | Final evaluation: score per criterion, comment, hiring recommendation; total and grade (p.2, p.4) | ✅ | Yes | **DEPLOYED TO PRODUCTION — 2026-11-24** (stages S2.1–S2.5; release tag `ims-r27-final-evaluation-20261124`, commit `58937b3`; Neon migrations `FinalEvaluations`, `EvaluationWriteGuards` and `EvaluationCorrections` applied (17 → 20) with the `ims_app` grants; Worker `27a0b79d`, Pages `cd5daf06`; see [deployment.md](deployment.md); authenticated production UI checks and the first post-release Cron run are still to be verified; the evaluation requests and reminders are R28, not implemented; certificates are separate). History: **Rules decided (AD-66, owner, 2026-11-14)**: one evaluation per application by the final mentor or the current responsible HR, Admin criteria in Arabic and English without weights, scores 1–5, mandatory comment and hiring recommendation, five grades, shared draft, frozen at first submission, audited corrections, trainee sees the grade only; the latest mentor keeps the right for that application whatever their later role (NEW-38), except an Admin-role final mentor, who cannot evaluate (AD-68 G2, owner 2026-11-18, supersedes NEW-38 for that case); follow-up decisions G3–G6 in AD-68. Not in production. **Stage S2.1 committed and on GitHub** (2026-11-22, `e55e63c`, AD-69; not deployed); **stage S2.2, the shared draft, committed and on GitHub** (2026-11-22, `1d53d71`, AD-70; local tests and UAT passed; not deployed): the schema (`evaluations`, `evaluation_scores`, `evaluation_corrections`, no stored mean or grade; the Worker reads them and, since S2.2, writes only the draft's columns), the evaluators' list and detail (`GET /api/evaluations`, `/api/evaluations/:applicationId`) and Evaluations pages in the Employee and HR areas, where the final mentor and the current responsible HR save an incomplete shared draft together (`PUT /api/evaluations/:applicationId/draft`, optimistic concurrency, database write guards), and the evaluation events left out of the Admin audit log (with an opaque Load More cursor). **Stage S2.3, submission and the verbal grade, committed and pushed to GitHub** (2026-11-23, `e910f38`, GitHub `main` at `8e1cab5`, AD-71; 1,303/1,303 automated tests and Local UAT passed; **not deployed** to Production; no production database change): the saved draft is submitted (`POST /api/evaluations/:applicationId/submit`, atomic, the criteria frozen under a table lock, refused when the criteria changed or the draft is incomplete), and its evaluators then see it read-only with the frozen scores, comment, recommendation, submitter's name, time and verbal grade (never a mean). **Stage S2.4, corrections, implemented, tested, UAT passed, committed and pushed to GitHub** (2026-11-23, `13e4119`, AD-72; authorization decided under row locks; Worker 751/751, C# 176/176 and frontend 461/461 in the final runs, UAT 48/48; **NOT deployed** to Production; the `EvaluationCorrections` migration not applied to any persistent database): the current final mentor or responsible HR corrects a submitted evaluation's frozen scores, comment and recommendation on a separate page (`GET /api/evaluations/:applicationId/correction`, `POST /api/evaluations/:applicationId/corrections`, atomic, audited, guarded by the database: a record per correction with a net change), and the evaluators see the latest correction's time, corrector and reason only. **Stage S2.5, the trainee's grade** (AD-73, owner decisions 2026-11-24): implemented and tested locally, committed and pushed (`fc80456`), deployed to production on 2026-11-24: on the status board the trainee sees, only once the evaluation is submitted, its verbal grade (the latest correction) and the original submission date, or the approved no-grade text; nothing before. All five R27 stages were released to production together on 2026-11-24 |
| R28 | Automatic evaluation reminder (p.2 step 8) | ❌ | — | **Rules decided (AD-66)**: e-mail + in-app request when HR completes or ends early; e-mail reminders every `late_evaluation_reminder_days` at 09:00 Asia/Hebron, the responsible HR from the third, catch-up limits; measured from the recorded ending, an interval change applies from the last reminder sent (NEW-37). Implemented after R27 (AD-68 G6). Not built |

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
| R39 | Fields report (HR, Admin) | 🟡 | Yes | No completed count: L1 is answered (AD-63) but the counting rule is open (NEW-39); filters NEW-12 |
| R40 | Mentor profile (HR; each employee for themself) | 🟡 | Yes | HR employee filter (RN-1, 2026-11-04). No average: the final evaluation is not built (AD-66) and the mentor-profile average is open (NEW-03, mentor-profile part); no "over time" (NEW-13). No Admin access (NEW-02 answered) |
| R41 | Hiring pipeline (HR) | ❌ | — | Needs the final evaluation (AD-66, not built). Ranking basis answered (NEW-03, owner 2026-11-16): the trainee's most recent final evaluation, its AD-66 mean |
| R42 | Trainee history (HR) | ✅ | Yes | Period and field filters; employee filter NEW-14 |
| R43 | Every report filtered by period, field and employee | 🟡 | Yes | Where the meaning is defined (mentor profile: employee, HR, 2026-11-04) |
| R44 | Export every report to Excel or PDF | ✅ | Yes | Excel and PDF for the four built reports (AD-55); deployed 2026-11-04 and verified in production by the owner. The hiring pipeline (R41) is not built yet; its export comes with it |

## Notifications and e-mail (p.3–4)

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R45 | In-app notifications | 🟡 | Yes | 4 of the in-app events (AD-50), and a fifth, the direct assignment to the mentor, in production since 2026-11-14 (AD-67); Q14, lifecycle, scheduler |
| R46 | E-mail events and bilingual templates | 🟡 | Yes The two pending-request reminder e-mails (NEW-05) are in production since 2026-11-15 (Worker `c007ee03`); none has been sent yet (no eligible request). | The direct-assignment e-mails to the mentor and the trainee (AD-67) are in production since 2026-11-14 (Worker `950d83d5`). The incoming-mentor e-mail of an executed transfer (AD-65, owner decision 2026-11-13) is in production since 2026-11-13 (Worker `839ed022`); the one earlier transfer got it through an authorized one-time catch-up (accepted by Gmail, SMTP 250). The eight event e-mails of the existing workflows are in production since 2026-11-11 (Worker `55570602`, commit `098279f`; manually tested by the owner locally): new application and mentor request to every HR user (NEW-24; since 2026-11-13 the mentor request only to the application's current responsible HR, AD-64, Worker `e7913829`); received, accepted, rejected with its reason, and the mentor assignment with the mentor's name and work e-mail (NEW-30) to the trainee; mentor request approved or rejected to the employee. Bilingual HTML and plain text, Arabic first, sender ProGineer (AD-60). Missing: the reminders, weekly summary, training-ended, late-evaluation and certificate e-mails (their features are not built), and delivery tracking, retries and the failed-e-mail page (Phase 3, 4); open NEW-19 to NEW-23, NEW-24 for the pending reminder only, NEW-26 to NEW-29, NEW-31 (NEW-25 and NEW-30 answered) |
| R47 | Timed reminders (7 days, late evaluation every 3 days, pending > 5 days) | 🟡 | Yes | Pending > 5 days **in production since 2026-11-15** (AD-61 items 4–18; Worker `c007ee03`; Cron Trigger `0 6,7 * * *`, 09:00 Asia/Hebron; one e-mail per request and recipient, once, no batching; **launch cutoff** `2026-11-15T19:10:00Z`: requests created before it are never reminded); first production run 2026-11-16 at about 09:01 Asia/Hebron: `candidates: 0`, `failed: 0`, `emailsFailed: 0`, no Cloudflare errors; `pending_reminders` empty; no eligible request yet, so the production e-mail delivery path has not been exercised. Late evaluation and approaching end decided (AD-66, NEW-37, NEW-38), **not implemented** |
| R48 | Weekly summary to HR | ❌ | — | NEW-04; e-mail |
| R50 | Notification "email status" field (p.4) | ❌ | — | Needs the event e-mails (D-50); Q42 answered 2026-11-10 (AD-59) |

## Data, platform and security

| # | Requirement (PDF) | Status | Prod | Notes |
|---|---|---|---|---|
| R51 | Employee department (p.4) | 🟡 | Yes | Column exists, never set (Q32) |
| R52 | Responsive Arabic (RTL) and English interface (p.5) | ✅ | Yes | React (AD-34) |
| R53 | A trainee reaches only their own data (p.5) | ✅ | Yes | |
| R54 | Private files served through temporary links (p.5) | ✅ | Yes | R2, 5-minute signed links (AD-48) |
| R55 | Rate limiting on the application form (p.5) | ✅ | Yes | Also on trainee sign-in; the 429 says `Retry-After: 60` |
| R56 | CAPTCHA on the application form (p.5) | ➖ | — | **Out of scope** (owner decision 2026-11-16, Q22): CAPTCHA is no longer required; rate limiting stays (R55) |
| R57 | Scheduled jobs (p.5) | 🟡 | Yes | Two jobs in production: the due transfers (AD-65, since 2026-11-13) and the pending-request reminder (NEW-05, since 2026-11-15, Worker `c007ee03`). Still needed by R28, the other reminders of R47, and R48 |
| R58 | Daily database backup (p.5) | ⏸ | — | Deferred until development is complete (AD-54); Neon restore window 6 hours |
| R59 | Domain and system name (p.6, Q10) | 🔒 | — | Hosting decided (Cloudflare); domain and DNS open |
| R60 | Attendance or hours tracking (p.6, Q6) | ⏸ | — | Paused |
| R61 | University forms to print (p.6, Q7) | ❌ | — | May not be needed (Q7) |
| R62 | Import of past trainees (p.6, Q9) | ❌ | — | Q9 |
| R64 | HR ownership of individual trainees (owner, 2026-11-02) | 🟡 | Yes | In production since 2026-11-13 (AD-64; Worker `e7913829`, Pages `b8d97853`): each accepted application has a responsible HR (the accepting HR, or an Admin's replacement, history kept), and the mentor-request e-mail and in-app notification go to that HR only. Wider ownership: NEW-10 |

R23, R30, R49 and R63 of the audit were merged into the rows above.
