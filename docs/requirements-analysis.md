# Requirements Analysis

Source of truth: *خطة نظام إدارة المتدربين* (Trainee Management System Plan, 22 Oct 2026).
This file restates the PDF in engineering terms. It does not add requirements. Anything the PDF leaves open is listed in [decisions.md](decisions.md).

## 1. Problem & goal

Trainees reach the company informally. Approvals happen verbally and by phone, and there is no record of who trained, when, with whom, or how they were evaluated.
The system tracks every trainee from application to certificate and keeps a **permanent record** of every training.

Goals (PDF §1):
1. One portal where students apply and choose a training field.
2. HR approves applications and assigns each trainee to an employee, and records verbal communication.
3. Employees browse accepted trainees and request to mentor them. One employee can mentor several trainees.
4. A final evaluation for each trainee, plus a public certificate page that can be published and printed.
5. Records are never deleted. Monthly reports show who trained and with whom.

## 2. Glossary (Arabic → code name)

| Arabic | Code name | Meaning |
|---|---|---|
| متدرب | `Trainee` | Student applying for and doing a training |
| موظف / مدرّب | `Employee` (acting as mentor) | Company staff member who trains trainees |
| الموارد البشرية | HR (`StaffRole.Hr`) | Reviews applications and approves assignments |
| المدير | Admin (`StaffRole.Admin`) | Configures fields, criteria, users, settings |
| طلب تدريب (من الطالب) | `TrainingApplication` | A trainee's application. Named this way to avoid clashing with the `Ims.Application` layer |
| مجال | `Field` | Training field (Frontend, Backend, QA, Design, …) |
| طلب تدريب متدرب (من الموظف) | `MentorRequest` | An employee asks to mentor an accepted trainee |
| ربط | `Assignment` | Approved trainee↔employee link with start and end dates |
| ملاحظات متابعة | `ProgressNote` | Periodic notes during training |
| سجل التواصل | `ContactLog` | HR log of calls and verbal agreements |
| معيار التقييم | `EvaluationCriterion` | Admin-defined criterion with a weight and an order |
| التقييم النهائي | `Evaluation` | Final evaluation of an assignment |
| الشهادة | `Certificate` | Public, verifiable certificate |
| سجل التغييرات | `AuditLog` | Who did what, and when |

## 3. Roles & permissions (PDF §2 matrix)

Trainees never see each other.

| Capability | Trainee | Employee | HR | Admin |
|---|---|---|---|---|
| Sign-in method | Email magic link / one-time code | Google | Google | Google |
| Submit training application | ✔ | | | |
| Track own application & certificate | ✔ | | | |
| View accepted trainees | | ✔ | ✔ | ✔ |
| Request to mentor a trainee | | ✔ | | |
| Approve applications & assignments | | | ✔ | |
| Record contact notes | | | ✔ | |
| Evaluate | | own trainees only | ✔ | |
| Reports | | own reports only | all | all |
| Manage fields, evaluation criteria, users | | | | ✔ |

Staff sign-in is limited to the company's Google domain. Any new account from that domain is created automatically with the **Employee** role. Admin grants higher roles.

## 4. Trainee lifecycle (PDF §3)

Training starts only after two HR decisions: **accept the application**, then **approve the assignment**.

```
1 Submit ─► 2 HR review & contact (ContactLog) ─► 3 Decision ─┬─► Rejected (kept on record)
                                                               └─► Accepted
4 Listed as available to employees ─► 5 Employee sends MentorRequest
6 HR decision on MentorRequest ─┬─► Rejected → trainee goes back to the available list
                                └─► Approved → Assignment created with start/end dates
7 Training in progress (transfer to another employee / extend / end early / withdraw)
8 Final evaluation (automatic reminder to the employee)
9 Completed → certificate (public page, PDF, QR)
```

A trainee may apply again later, for example in another field. Every training stays on their record.

## 5. Features by role (PDF §4)

**Trainee**
- Register and sign in by email only (no password), using a link or code sent to the email.
- Application form fields: name, phone, university, major, study year, requested field, available period, number of hours, whether the training is mandatory for the university, CV upload, and any university letter.
- Status board showing where their application is, with no other trainee's name visible.
- After evaluation, decide whether to publish their certificate page or keep it private. Print or download it as PDF.

**Employee**
- List of available trainees (accepted and not yet assigned), filterable by field, university and period, with CV viewing.
- "I want to train them" button with a short note on what they will work on. The request then waits for HR approval.
- My trainees: current and past, with periodic progress notes.
- Final evaluation: a form built from the Admin's fixed criteria, with a score per criterion, a comment, and a hiring recommendation (Yes / Maybe / No).

**HR**
- New-applications inbox: review, log every call or verbal agreement in the ContactLog (date, method, summary), then accept, or reject with a reason.
- Mentor requests: see every request, approve after coordination, and set start and end dates.
- Running trainings: extend, end early, transfer to another employee, or record a withdrawal, always with the reason saved.
- Direct assignment of a trainee to an employee without waiting for a request.
- Reports and exports.

**Admin**
- Manage fields, evaluation criteria and their weights, the certificate template, users and roles.
- Manage notification timing settings.

## 6. Public certificate page (PDF §5)

- Each completed training generates a page with a fixed link and a verification code, for example `training.company.com/c/X7K2P9`. The code is random and cannot be guessed.
- Content: trainee name, field, university, training period and hours, mentor name, overall grade, and the mentor's comment.
- A QR code on the page and on the printed copy opens the same page, so anyone can verify the certificate.
- An official PDF design with the company logo and the HR signature.
- A ready-made "Share on LinkedIn" button.
- **Revocation**: if HR revokes a certificate, the page stays up and shows that it is invalid.
- Privacy proposal: detailed numeric scores stay internal. The public page shows only an overall grade (Excellent / Very good / Good) and the mentor's comment.

## 7. Records & reports (PDF §6)

- Nothing is deleted. Rejected, withdrawn and cancelled items keep their status, so any month can be reviewed later.
- **Audit log**: every action (accept, reject, assign, transfer, extend, evaluate, publish certificate) is recorded with who did it and when.

| Report | Content | Audience |
|---|---|---|
| Monthly | Everyone training during the month: with whom, which field, from/to | HR, Admin |
| Fields | Applications, accepted and completed per field | HR, Admin |
| Mentor profile | Trainees per employee over time and their average evaluation | HR; each employee for themselves |
| Hiring pipeline | Trainees recommended for hiring, ranked by evaluation | HR |
| Trainee history | All trainings of one trainee and their contact notes | HR |

Every report can be filtered by period, field and employee, and exported to Excel or PDF.
**Technical note (PDF)**: the monthly report is built from `Assignment` start and end dates. An assignment appears in every month its period overlaps. A transfer creates two separate assignments, so nothing is lost.

## 8. Notifications (PDF §7)

| Event | Recipient | Channel |
|---|---|---|
| New training application | HR | Email + in-app |
| Application received (confirmation) | Trainee | Email |
| Application accepted / rejected | Trainee | Email |
| New available trainee in your field | Field employees (optional, can be muted) | In-app |
| Employee requested to mentor a trainee | HR | Email + in-app |
| Assignment approved / rejected | Employee | Email + in-app |
| Assignment approved (start date and mentor details) | Trainee | Email |
| Training ends in 7 days | Employee and HR | In-app |
| Training ended: fill in the evaluation | Employee | Email + in-app |
| Late evaluation reminder (every 3 days) | Employee; HR copied after the 2nd reminder | Email |
| Certificate ready | Trainee | Email with page link |
| Request pending more than 5 days | HR | Email |
| Weekly summary | HR | Email |
| Sign-in link / code | Trainee | Email |

The 7-, 3- and 5-day intervals are Admin settings. Email templates exist in Arabic and English.

## 9. Data model (PDF §8)

See [domain-model.md](domain-model.md).

## 10. Technical requirements (PDF §9)

| Layer | Proposed | Notes |
|---|---|---|
| Frontend | Angular, responsive, Arabic (RTL) + English | One app with three role areas plus a lightweight public certificate page |
| Backend | ASP.NET Core Web API | Role-based permissions, automatic audit on every change |
| Database | PostgreSQL | |
| Staff sign-in | Google OAuth limited to the company domain | |
| Trainee sign-in | Passwordless one-time email link or code | Link valid for 15 minutes |
| Files | S3 or Azure Blob | CVs and university letters |
| Email | SendGrid or Amazon SES | Bilingual templates |
| Scheduled jobs | Hangfire or similar | Reminders and the weekly summary |
| PDF & QR | Generated on the server from an HTML template | |
| Hosting | Azure or AWS | Daily database backup |

**Security**: a trainee can access only their own data. Files are served through temporary links. The application form is protected with rate limiting and CAPTCHA.

## 11. Delivery phases (PDF §10)

About 11 weeks for one full-stack developer, plus about 1 week of testing with HR. Phase 1 alone is enough to start using the system.

| Phase | Scope | Est. |
|---|---|---|
| 1. Core (MVP) | Role sign-in, application form, HR dashboard and contact log, available-trainees list, mentor requests and approval, final evaluation, audit log, accept/reject/assignment emails | 6 wks |
| 2. Certificates & reports | Public certificate page, PDF and QR, monthly report and the other reports, Excel and PDF export | 3 wks |
| 3. Automation | Reminders and weekly summary, progress notes, transfer and extension, Admin settings for criteria and templates, LinkedIn share | 2 wks |
