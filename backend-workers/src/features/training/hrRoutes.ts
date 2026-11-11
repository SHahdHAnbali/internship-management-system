import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { ConcurrencyError, DomainError, NotFoundError } from '../../domain/errors';
import { updateOrConflict } from '../../db';
import { required } from '../../domain/guard';
import {
  APPLICATION_STATUSES,
  CONTACT_METHODS,
  CONTACT_SUMMARY_MAX_LENGTH,
  assertCanDecide,
  assertCanReview,
  assertPending,
  ASSIGNMENT_END_REASON_MAX_LENGTH,
  calendarDate,
  endAssignment,
  type AssignmentEndingKind,
  MENTOR_REQUEST_STATUSES,
  parseDate,
  period,
  REJECTION_REASON_MAX_LENGTH,
  type ApplicationStatus,
  type MentorRequestStatus,
} from '../../domain/training';
import { parseGuid, uuidV7 } from '../../domain/uuid';
import { bindJson, type RequestSchema } from '../../http/body';
import { json, statusProblem } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';
import { applicationDecisionEmails, mentorRequestDecisionEmails, sendEventEmails } from '../notifications/eventEmails';
import { notifyEmployee } from '../notifications/notify';
import { readableAttachment } from './access';
import { fileLink } from './files';
import { attachmentsOf } from './traineeRoutes';

/**
 * `/api/hr` (HR role only; PDF §2: HR approves applications and assignments). Only what the Employee area needs so
 * far: reviewing applications (Under Review, the contact log, accept, reject with a reason) and deciding mentor
 * requests (approve with the start and end dates, which starts the assignment; or reject).
 */
const rejectRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.RejectApplicationRequest',
  properties: [{ name: 'Reason', kind: 'string', required: true, maxLength: REJECTION_REASON_MAX_LENGTH }],
};

const contactLogRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.ContactLogRequest',
  properties: [
    { name: 'ContactDate', kind: 'string', required: true, maxLength: 10 },
    { name: 'Method', kind: 'string', required: true, maxLength: 20 },
    { name: 'Summary', kind: 'string', required: true, maxLength: CONTACT_SUMMARY_MAX_LENGTH },
  ],
};

const approveRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.ApproveMentorRequest',
  properties: [
    { name: 'StartDate', kind: 'string', required: true, maxLength: 10 },
    { name: 'EndDate', kind: 'string', required: true, maxLength: 10 },
  ],
};

// AD-63 Phase 1: HR ends a training with its actual end date and, where required, a reason.
const endAssignmentRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.EndAssignmentRequest',
  properties: [
    { name: 'EndDate', kind: 'string', required: true, maxLength: 10 },
    { name: 'Reason', kind: 'string', required: false, maxLength: ASSIGNMENT_END_REASON_MAX_LENGTH },
  ],
};

const APPLICATION_SELECT = `
  SELECT a.id, a.status, a.available_from::text, a.available_to::text, a.hours, a.mandatory_for_university,
         a.submitted_at, a.decided_at, a.rejection_reason, f.id AS field_id, f.name AS field_name,
         t.id AS trainee_id, t.email, t.full_name, t.phone, t.university, t.major, t.study_year
    FROM training_applications a JOIN fields f ON f.id = a.field_id JOIN trainees t ON t.id = a.trainee_id`;

interface ApplicationRow {
  id: string;
  status: ApplicationStatus;
  available_from: string;
  available_to: string;
  hours: number;
  mandatory_for_university: boolean;
  submitted_at: Date;
  decided_at: Date | null;
  rejection_reason: string | null;
  field_id: string;
  field_name: string;
  trainee_id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  university: string | null;
  major: string | null;
  study_year: string | null;
}

function toApplication(a: ApplicationRow) {
  return {
    id: a.id,
    status: a.status,
    field: { id: a.field_id, name: a.field_name },
    trainee: {
      id: a.trainee_id,
      email: a.email,
      fullName: a.full_name,
      phone: a.phone,
      university: a.university,
      major: a.major,
      studyYear: a.study_year,
    },
    availableFrom: a.available_from,
    availableTo: a.available_to,
    hours: a.hours,
    mandatoryForUniversity: a.mandatory_for_university,
    submittedAt: a.submitted_at,
    decidedAt: a.decided_at,
    rejectionReason: a.rejection_reason,
  };
}

async function application(c: Context<AppEnv>, id: string) {
  const { rows } = await c.var.db.query<ApplicationRow>(`${APPLICATION_SELECT} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw NotFoundError.for('TrainingApplication', id);
  return rows[0];
}

/** Changes the status only if nobody changed it meanwhile (else 409). */
async function changeApplication(
  c: Context<AppEnv>,
  id: string,
  from: ApplicationStatus,
  set: string,
  params: unknown[],
) {
  await c.var.db.transaction(c.var.actor, async (tx) => {
    const { rowCount } = await tx.query(`UPDATE training_applications SET ${set} WHERE id = $1 AND status = $2`, [
      id,
      from,
      ...params,
    ]);
    if (rowCount === 0) throw new ConcurrencyError();
  });
  return toApplication(await application(c, id));
}

export const hrRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/hr/applications',
    policy: 'HR',
    async handle(c) {
      const status = c.req.query('status');
      const filter = (APPLICATION_STATUSES as readonly string[]).includes(status ?? '') ? status : null;
      const { rows } = await c.var.db.query<ApplicationRow>(
        `${APPLICATION_SELECT} WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.submitted_at`,
        [filter],
      );
      return json(rows.map(toApplication));
    },
  },
  {
    method: 'GET',
    path: '/api/hr/applications/:id',
    policy: 'HR',
    async handle(c) {
      const a = await application(c, routeId(c));
      const files = await attachmentsOf(c, [a.id]);
      return json({ ...toApplication(a), attachments: files.get(a.id) ?? [] });
    },
  },
  {
    // Owner decision 2026-10-29: HR puts a submitted application under review explicitly.
    method: 'POST',
    path: '/api/hr/applications/:id/review',
    policy: 'HR',
    async handle(c) {
      const a = await application(c, routeId(c));
      assertCanReview(a.status);
      return json(await changeApplication(c, a.id, a.status, "status = 'UnderReview'", []));
    },
  },
  {
    method: 'POST',
    path: '/api/hr/applications/:id/accept',
    policy: 'HR',
    async handle(c) {
      const a = await application(c, routeId(c));
      assertCanDecide(a.status);
      const accepted = await changeApplication(
        c,
        a.id,
        a.status,
        "status = 'Accepted', decided_at = $3, decided_by_id = $4",
        [c.var.deps.now(), c.var.user!.id],
      );
      await sendEventEmails(c, (q) => applicationDecisionEmails(q, a.id)); // PDF §7, after the commit (best effort)
      return json(accepted);
    },
  },
  {
    // PDF §4: reject with a reason (kept on record).
    method: 'POST',
    path: '/api/hr/applications/:id/reject',
    policy: 'HR',
    async handle(c) {
      const body = await bindJson<{ reason: string }>(c.req.raw, rejectRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const reason = required(body.value.reason, 'Rejection reason', REJECTION_REASON_MAX_LENGTH);
      const a = await application(c, routeId(c));
      assertCanDecide(a.status);
      const rejected = await changeApplication(
        c,
        a.id,
        a.status,
        "status = 'Rejected', decided_at = $3, decided_by_id = $4, rejection_reason = $5",
        [c.var.deps.now(), c.var.user!.id, reason],
      );
      // PDF §7 and AD-61: the rejection e-mail carries the stored reason; after the commit (best effort).
      await sendEventEmails(c, (q) => applicationDecisionEmails(q, a.id));
      return json(rejected);
    },
  },
  {
    // The contact log of an application (PDF §4, §8): every call or verbal agreement, newest first.
    method: 'GET',
    path: '/api/hr/applications/:id/contact-logs',
    policy: 'HR',
    async handle(c) {
      const a = await application(c, routeId(c));
      const { rows } = await c.var.db.query<{
        id: string;
        contact_date: string;
        method: string;
        summary: string;
        recorded_at: Date;
        author_name: string;
      }>(
        `SELECT l.id, l.contact_date::text, l.method, l.summary, l.recorded_at, e.full_name AS author_name
           FROM contact_logs l JOIN employees e ON e.id = l.author_id
          WHERE l.application_id = $1 ORDER BY l.contact_date DESC, l.recorded_at DESC`,
        [a.id],
      );
      return json(
        rows.map((l) => ({
          id: l.id,
          contactDate: l.contact_date,
          method: l.method,
          summary: l.summary,
          recordedAt: l.recorded_at,
          authorName: l.author_name,
        })),
      );
    },
  },
  {
    // Records a call or verbal agreement (PDF §8: application, author, date, method, summary). No decision depends on it.
    method: 'POST',
    path: '/api/hr/applications/:id/contact-logs',
    policy: 'HR',
    async handle(c) {
      const body = await bindJson<{ contactDate: string; method: string; summary: string }>(
        c.req.raw,
        contactLogRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;
      const contactDate = parseDate(body.value.contactDate);
      if (!contactDate) throw new DomainError('validation.required', 'The contact date is required.');
      if (!(CONTACT_METHODS as readonly string[]).includes(body.value.method)) {
        throw new DomainError('validation.invalid', 'The contact method must be Phone, Meeting or Email.');
      }
      const summary = required(body.value.summary, 'Summary', CONTACT_SUMMARY_MAX_LENGTH);
      const a = await application(c, routeId(c));

      const now = c.var.deps.now();
      const id = uuidV7(now);
      await c.var.db.transaction(c.var.actor, (tx) =>
        tx.query(
          `INSERT INTO contact_logs (id, application_id, author_id, contact_date, method, summary, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, a.id, c.var.user!.id, contactDate, body.value.method, summary, now],
        ),
      );
      return json({ id, contactDate, method: body.value.method, summary, recordedAt: now }, 201);
    },
  },
  {
    method: 'POST',
    path: '/api/hr/attachments/:id/link',
    policy: 'HR',
    async handle(c) {
      const attachment = await readableAttachment(c.var.db, c.var.user!, routeId(c));
      if (!attachment) return statusProblem(404, c.var.traceId, true);
      return json(await fileLink(c, attachment.id, c.var.user!.id));
    },
  },
  {
    // Every employee's requests (PDF §4: HR sees any request from any employee).
    method: 'GET',
    path: '/api/hr/mentor-requests',
    policy: 'HR',
    async handle(c) {
      const status = c.req.query('status');
      const filter = (MENTOR_REQUEST_STATUSES as readonly string[]).includes(status ?? '') ? status : null;
      const { rows } = await c.var.db.query<MentorRequestRow>(
        `${MENTOR_REQUEST_SELECT} WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.requested_at`,
        [filter],
      );
      return json(rows.map(toMentorRequest));
    },
  },
  {
    // PDF §4: approve after coordination and set the start and end dates; this starts the training (the assignment).
    method: 'POST',
    path: '/api/hr/mentor-requests/:id/approve',
    policy: 'HR',
    async handle(c) {
      const body = await bindJson<{ startDate: string; endDate: string }>(c.req.raw, approveRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const dates = period(
        body.value.startDate,
        body.value.endDate,
        'The training period',
        'assignment.invalid_period',
      );
      const request = await mentorRequest(c, routeId(c));
      assertPending(request.status);

      const now = c.var.deps.now();
      const assignmentId = uuidV7(now);
      await c.var.db.transaction(c.var.actor, async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE mentor_requests SET status = 'Approved', decided_at = $2, decided_by_id = $3
            WHERE id = $1 AND status = 'Pending'`,
          [request.id, now, c.var.user!.id],
        );
        if (rowCount === 0) throw new ConcurrencyError();
        await tx.query(
          `INSERT INTO assignments (id, application_id, employee_id, mentor_request_id, start_date, end_date, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'Active', $7)`,
          [assignmentId, request.application_id, request.employee_id, request.id, dates.start, dates.end, now],
        );
        // PDF §7: "assignment approved or rejected" goes to the employee who asked.
        await notifyEmployee(tx, request.employee_id, 'MentorRequestApproved', request.id, now);
      });
      // PDF §7: e-mails to the employee and, with the start details, to the trainee; after the commit (best effort).
      await sendEventEmails(c, (q) => mentorRequestDecisionEmails(q, request.id));
      return json({ ...toMentorRequest(await mentorRequest(c, request.id)), assignmentId });
    },
  },
  {
    // PDF §4: HR rejects a request; the trainee stays available while not assigned.
    method: 'POST',
    path: '/api/hr/mentor-requests/:id/reject',
    policy: 'HR',
    async handle(c) {
      const request = await mentorRequest(c, routeId(c));
      assertPending(request.status);
      const now = c.var.deps.now();
      await c.var.db.transaction(c.var.actor, async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE mentor_requests SET status = 'Rejected', decided_at = $2, decided_by_id = $3
            WHERE id = $1 AND status = 'Pending'`,
          [request.id, now, c.var.user!.id],
        );
        if (rowCount === 0) throw new ConcurrencyError();
        await notifyEmployee(tx, request.employee_id, 'MentorRequestRejected', request.id, now);
      });
      await sendEventEmails(c, (q) => mentorRequestDecisionEmails(q, request.id)); // PDF §7, after the commit
      return json(toMentorRequest(await mentorRequest(c, request.id)));
    },
  },
  {
    // PDF §4 "running training": every assignment with its trainee, mentor, field, dates, status and, once ended, the
    // reason HR recorded (shown to HR only, AD-63). Ending is below; extend, transfer and reopen are not built.
    method: 'GET',
    path: '/api/hr/assignments',
    policy: 'HR',
    async handle(c) {
      return json(await hrAssignments(c));
    },
  },
  {
    // AD-63: a successful completion; the actual end date decides Completed (on or after the planned end) or EndedEarly.
    method: 'POST',
    path: '/api/hr/assignments/:id/complete',
    policy: 'HR',
    handle: (c) => endHrAssignment(c, 'completion'),
  },
  {
    // AD-63: the trainee's withdrawal, recorded by HR with its date and reason.
    method: 'POST',
    path: '/api/hr/assignments/:id/withdraw',
    policy: 'HR',
    handle: (c) => endHrAssignment(c, 'withdrawal'),
  },
  {
    // The choice of trainee for the "trainee history" report (PDF §6): owner decision 2026-11-02, only trainees with at
    // least one Accepted application (AD-47), each once. Read-only.
    method: 'GET',
    path: '/api/hr/trainees',
    policy: 'HR',
    async handle(c) {
      const { rows } = await c.var.db.query<{
        id: string;
        email: string;
        full_name: string | null;
        university: string | null;
        applications: number;
      }>(
        `SELECT t.id, t.email, t.full_name, t.university, count(a.id)::int AS applications
           FROM trainees t JOIN training_applications a ON a.trainee_id = t.id
          GROUP BY t.id
         HAVING bool_or(a.status = 'Accepted')
          ORDER BY t.full_name NULLS LAST, t.email`,
      );
      return json(
        rows.map((r) => ({
          id: r.id,
          email: r.email,
          fullName: r.full_name,
          university: r.university,
          applications: r.applications,
        })),
      );
    },
  },
  {
    // The data of the HR report "trainee history" (PDF §6 «سجل المتدرب»: every training of one trainee and the contact
    // notes kept with them). Read-only, as recorded: each application with its assignments and contact-log entries.
    // Optional filters on the trainings only (PDF §6 "filtered by period and field"): `from` / `to` keep the assignments
    // whose recorded dates overlap that period (inclusive), `fieldId` those of applications in that field. Applications
    // and their contact notes are always all returned.
    method: 'GET',
    path: '/api/hr/trainees/:id/history',
    policy: 'HR',
    async handle(c) {
      const id = routeId(c);
      const filters = historyFilters(c);
      const { rows: trainees } = await c.var.db.query<{
        id: string;
        email: string;
        full_name: string | null;
        phone: string | null;
        university: string | null;
        major: string | null;
        study_year: string | null;
      }>(
        `SELECT id, email, full_name, phone, university, major, study_year FROM trainees t
          WHERE t.id = $1
            AND EXISTS (SELECT 1 FROM training_applications a WHERE a.trainee_id = t.id AND a.status = 'Accepted')`,
        [id],
      );
      const t = trainees[0];
      // The same eligibility as the list: a trainee without an Accepted application is not in this report.
      if (!t) throw NotFoundError.for('Trainee', id);

      const { rows } = await c.var.db.query<{
        id: string;
        status: ApplicationStatus;
        field_id: string;
        field_name: string;
        available_from: string;
        available_to: string;
        hours: number;
        submitted_at: Date;
        decided_at: Date | null;
        rejection_reason: string | null;
        assignments: {
          id: string;
          employeeName: string;
          status: string;
          startDate: string;
          endDate: string;
          endReason: string | null;
        }[];
        contact_logs: {
          id: string;
          contactDate: string;
          method: string;
          summary: string;
          recordedAt: string;
          authorName: string;
        }[];
      }>(
        `SELECT a.id, a.status, f.id AS field_id, f.name AS field_name, a.available_from::text, a.available_to::text,
                a.hours,
                a.submitted_at, a.decided_at, a.rejection_reason,
                coalesce((SELECT json_agg(json_build_object('id', s.id, 'employeeName', e.full_name, 'status', s.status,
                                                            'startDate', s.start_date, 'endDate', s.end_date,
                                                            'endReason', s.end_reason)
                                          ORDER BY s.start_date, s.created_at)
                            FROM assignments s JOIN employees e ON e.id = s.employee_id
                           WHERE s.application_id = a.id
                             AND ($2::date IS NULL OR s.end_date >= $2::date)
                             AND ($3::date IS NULL OR s.start_date <= $3::date)
                             AND ($4::uuid IS NULL OR a.field_id = $4)), '[]') AS assignments,
                coalesce((SELECT json_agg(json_build_object('id', l.id, 'contactDate', l.contact_date,
                                                            'method', l.method, 'summary', l.summary,
                                                            'recordedAt', l.recorded_at, 'authorName', e.full_name)
                                          ORDER BY l.contact_date DESC, l.recorded_at DESC)
                            FROM contact_logs l JOIN employees e ON e.id = l.author_id
                           WHERE l.application_id = a.id), '[]') AS contact_logs
           FROM training_applications a JOIN fields f ON f.id = a.field_id
          WHERE a.trainee_id = $1
          ORDER BY a.submitted_at`,
        [t.id, filters.from, filters.to, filters.fieldId],
      );
      // How many trainings the trainee has in all, whatever the filters (the page offers filters only from two on).
      const { rows: total } = await c.var.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM assignments s JOIN training_applications a ON a.id = s.application_id
          WHERE a.trainee_id = $1`,
        [t.id],
      );
      return json({
        totalTrainings: total[0]!.n,
        trainee: {
          id: t.id,
          email: t.email,
          fullName: t.full_name,
          phone: t.phone,
          university: t.university,
          major: t.major,
          studyYear: t.study_year,
        },
        applications: rows.map((a) => ({
          id: a.id,
          status: a.status,
          fieldId: a.field_id,
          fieldName: a.field_name,
          availableFrom: a.available_from,
          availableTo: a.available_to,
          hours: a.hours,
          submittedAt: a.submitted_at,
          decidedAt: a.decided_at,
          rejectionReason: a.rejection_reason,
          assignments: a.assignments,
          contactLogs: a.contact_logs,
        })),
      });
    },
  },
];

/** The trainee history's optional training filters; a value given but malformed is refused (400). */
function historyFilters(c: Context<AppEnv>) {
  const date = (name: string) => {
    const value = c.req.query(name);
    if (!value) return null;
    const parsed = parseDate(value);
    if (!parsed) throw new DomainError('validation.invalid', `${name} must be a date (YYYY-MM-DD).`);
    return parsed;
  };
  const from = date('from');
  const to = date('to');
  if (from && to && to < from) throw new DomainError('validation.period', 'The period must end on or after its start.');
  const field = c.req.query('fieldId');
  const fieldId = field ? parseGuid(field) : null;
  if (field && !fieldId) throw new DomainError('validation.invalid', 'fieldId is not a valid id.');
  return { from, to, fieldId };
}

const MENTOR_REQUEST_SELECT = `
  SELECT r.id, r.status, r.note, r.requested_at, r.decided_at, r.application_id, r.employee_id,
         e.full_name AS employee_name, e.email AS employee_email, t.full_name AS trainee_name, f.name AS field_name,
         a.available_from::text, a.available_to::text
    FROM mentor_requests r JOIN employees e ON e.id = r.employee_id
    JOIN training_applications a ON a.id = r.application_id JOIN trainees t ON t.id = a.trainee_id
    JOIN fields f ON f.id = a.field_id`;

interface MentorRequestRow {
  id: string;
  status: MentorRequestStatus;
  note: string;
  requested_at: Date;
  decided_at: Date | null;
  application_id: string;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  trainee_name: string | null;
  field_name: string;
  available_from: string;
  available_to: string;
}

function toMentorRequest(r: MentorRequestRow) {
  return {
    id: r.id,
    status: r.status,
    note: r.note,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    employee: { id: r.employee_id, fullName: r.employee_name, email: r.employee_email },
    application: {
      id: r.application_id,
      traineeName: r.trainee_name,
      fieldName: r.field_name,
      availableFrom: r.available_from,
      availableTo: r.available_to,
    },
  };
}

async function mentorRequest(c: Context<AppEnv>, id: string) {
  const { rows } = await c.var.db.query<MentorRequestRow>(`${MENTOR_REQUEST_SELECT} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw NotFoundError.for('MentorRequest', id);
  return rows[0];
}

interface HrAssignmentRow {
  id: string;
  application_id: string;
  status: string;
  start_date: string;
  end_date: string;
  end_reason: string | null;
  trainee_id: string;
  trainee_name: string | null;
  trainee_email: string;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  field_name: string;
}

/** HR's view of the assignments (all, or one), newest first. */
async function hrAssignments(c: Context<AppEnv>, id: string | null = null) {
  const { rows } = await c.var.db.query<HrAssignmentRow>(
    `SELECT s.id, s.application_id, s.status, s.start_date::text, s.end_date::text, s.end_reason,
            t.id AS trainee_id, t.full_name AS trainee_name, t.email AS trainee_email,
            e.id AS employee_id, e.full_name AS employee_name, e.email AS employee_email, f.name AS field_name
       FROM assignments s JOIN employees e ON e.id = s.employee_id
       JOIN training_applications a ON a.id = s.application_id JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE ($1::uuid IS NULL OR s.id = $1)
      ORDER BY s.start_date DESC, s.created_at DESC`,
    [id],
  );
  return rows.map((r) => ({
    id: r.id,
    applicationId: r.application_id,
    status: r.status,
    startDate: r.start_date,
    endDate: r.end_date,
    endReason: r.end_reason,
    trainee: { id: r.trainee_id, fullName: r.trainee_name, email: r.trainee_email },
    employee: { id: r.employee_id, fullName: r.employee_name, email: r.employee_email },
    fieldName: r.field_name,
  }));
}

/**
 * Ends an Active assignment (AD-63 Phase 1): the rules are checked against the row as read, and the update applies only
 * if nobody changed it meanwhile (xmin, else 409). The actual end date replaces the planned one (L3); the audit trigger
 * keeps the old values with HR as the actor. No e-mail: the lifecycle sends none in this phase.
 */
async function endHrAssignment(c: Context<AppEnv>, kind: AssignmentEndingKind) {
  const body = await bindJson<{ endDate: string; reason: string | null }>(
    c.req.raw,
    endAssignmentRequest,
    c.var.traceId,
  );
  if (!body.ok) return body.response;
  const id = routeId(c);
  const { rows } = await c.var.db.query<{ status: string; start_date: string; end_date: string; version: string }>(
    'SELECT status, start_date::text, end_date::text, xmin::text AS version FROM assignments WHERE id = $1',
    [id],
  );
  const current = rows[0];
  if (!current) throw NotFoundError.for('Assignment', id);

  const ending = endAssignment(
    kind,
    body.value,
    { status: current.status, startDate: current.start_date, plannedEndDate: current.end_date },
    calendarDate(c.var.deps.now()),
  );
  await c.var.db.transaction(c.var.actor, (tx) =>
    updateOrConflict(
      tx,
      `UPDATE assignments SET status = $2, end_date = $3, end_reason = $4
        WHERE id = $1 AND status = 'Active' AND xmin = $5::xid`,
      [id, ending.status, ending.endDate, ending.reason, current.version],
    ),
  );
  return json((await hrAssignments(c, id))[0]);
}
