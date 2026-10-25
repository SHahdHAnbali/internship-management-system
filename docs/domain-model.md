# Domain Model

Derived from PDF §8. Field lists are the "most important fields" the PDF names. Status values the PDF does not spell out are marked *proposed* and need confirmation (see [decisions.md](decisions.md)).

> A trainee has applications. Each accepted application has one or more assignments to employees. Each assignment ends with an evaluation. Each completed training generates a certificate.

```
Trainee 1───* TrainingApplication *───1 Field
                     │ 1
                     ├──* ContactLog            (HR notes on verbal agreements)
                     ├──* MentorRequest *───1 Employee
                     │        └─ on approval ─► Assignment
                     ├──* Assignment *───1 Employee
                     │        ├──* ProgressNote
                     │        └──0..1 Evaluation ──* EvaluationScore *──1 EvaluationCriterion
                     └──0..1 Certificate         (generated from the evaluation)

Employee (staff user: Employee / HR / Admin)
Notification *──1 recipient (Trainee or Employee)
AuditLog — covers every table
```

| Entity | Key fields (PDF) | Relationships / rules |
|---|---|---|
| `Trainee` | name, email, phone, university, major, study year | Has many applications. Signs in by email only. |
| `Employee` | name, Google email, department, role (Employee / HR / Admin) | Has many assignments. Created automatically with role Employee on first Google sign-in from the company domain. |
| `Field` | name, description, active flag | Linked to applications and employees. Deactivated, never deleted. |
| `TrainingApplication` | trainee, field, requested period, hours, mandatory-for-university flag, status, rejection reason, attachments (CV, university letter) | Has many assignments. Status: *proposed* `Submitted → Accepted / Rejected`, then derived states (Available, InTraining, Completed). |
| `MentorRequest` | employee, application, note, status `Pending / Approved / Rejected` | Approval creates an `Assignment`. Rejection returns the trainee to the available list. |
| `Assignment` | application, employee, start date, end date, status, end/transfer reason | Has one evaluation and many progress notes. Transfer = close this assignment and open a new one. Status *proposed*: `Active, Completed, EndedEarly, Transferred, Withdrawn`. |
| `ProgressNote` | assignment, author, date, text | |
| `EvaluationCriterion` | name, weight, order | Defined by Admin. |
| `Evaluation` | assignment, score per criterion, total, grade, comment, hiring recommendation `Yes / Maybe / No` | Generates the certificate. Numeric detail stays internal. |
| `Certificate` | public code, published flag, issue date, revoked flag | Linked to the application. Revocation keeps the page and marks it invalid. |
| `ContactLog` | application, author, date, method `Phone / Meeting / Email`, summary | Records verbal agreements. |
| `Notification` | recipient, type, read flag, email status | |
| `AuditLog` | user, action, entity, value before/after, timestamp | Covers every table. Written automatically. |

## Cross-cutting rules

- **No hard deletes, anywhere.** Cancellation, withdrawal, rejection and revocation are status changes. EF Core must never issue a `DELETE` for domain tables.
- **Every state change is audited**: actor, action, entity, before and after values, UTC timestamp.
- **Reporting relies on `Assignment` date ranges.** A month includes every assignment whose `[start, end]` overlaps it.
- **Trainee data isolation**: every trainee-facing query is scoped to the signed-in trainee.
- **Identifiers**: `Guid` v7 (time-ordered) primary keys. Certificate public codes are a separate random, unguessable short code.
