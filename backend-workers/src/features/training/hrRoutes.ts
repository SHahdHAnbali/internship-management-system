import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { ConcurrencyError, DomainError, NotFoundError, StateConflictError } from '../../domain/errors';
import { updateOrConflict, type Queryable } from '../../db';
import { required } from '../../domain/guard';
import {
  APPLICATION_STATUSES,
  CONTACT_METHODS,
  CONTACT_SUMMARY_MAX_LENGTH,
  assertCanDecide,
  assertCanReview,
  assertPending,
  ASSIGNMENT_END_REASON_MAX_LENGTH,
  ASSIGNMENT_EXTENSION_REASON_MAX_LENGTH,
  calendarDate,
  endAssignment,
  decideTransfer,
  extendAssignment,
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
import { endpointFailure, json, statusProblem } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';
import { applicationDecisionEmails, mentorRequestDecisionEmails, sendEventEmails } from '../notifications/eventEmails';
import { notifyEmployee } from '../notifications/notify';
import { readableAttachment } from './access';
import { fileLink } from './files';
import { CURRENT_RESPONSIBLE_HR_ID } from './responsibleHr';
import {
  applyTransfer,
  assertNoDueTransfer,
  holdsEmployeeRole,
  lockAssignment,
  voidPendingTransfer,
} from './transfers';
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

// AD-63 L2, NEW-35: HR extends a training to a later planned end date, with a reason.
const extendAssignmentRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.ExtendAssignmentRequest',
  properties: [
    { name: 'EndDate', kind: 'string', required: true, maxLength: 10 },
    { name: 'Reason', kind: 'string', required: true, maxLength: ASSIGNMENT_EXTENSION_REASON_MAX_LENGTH },
  ],
};

// AD-65: the current responsible HR transfers a training to another mentor (an Employee), from today or a later date,
// with a reason.
const transferAssignmentRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.TransferAssignmentRequest',
  properties: [
    { name: 'EmployeeId', kind: 'string', required: true, maxLength: 36 },
    { name: 'TransferDate', kind: 'string', required: true, maxLength: 10 },
    { name: 'Reason', kind: 'string', required: true, maxLength: ASSIGNMENT_END_REASON_MAX_LENGTH },
  ],
};

// AD-65: the current responsible HR cancels a pending transfer, with a reason.
const cancelTransferRequest: RequestSchema = {
  typeName: 'Ims.Application.Hr.CancelTransferRequest',
  properties: [{ name: 'Reason', kind: 'string', required: true, maxLength: ASSIGNMENT_END_REASON_MAX_LENGTH }],
};

const notResponsible = () =>
  endpointFailure(
    403,
    'assignment.transfer_not_responsible',
    "Only the training application's current responsible HR may transfer it or cancel its transfer.",
  );

/**
 * Whether `hrId` is the application's current responsible HR (AD-64), read under a shared lock: an Admin's replacement
 * of the responsible HR waits for this transaction, and this one waits for a replacement already under way, so the
 * check and the change see the same holder.
 */
async function isResponsibleHr(tx: Queryable, applicationId: string, hrId: string): Promise<boolean> {
  const { rows } = await tx.query<{ responsible_hr_id: string }>(
    `SELECT ${CURRENT_RESPONSIBLE_HR_ID} AS responsible_hr_id FROM training_applications a WHERE a.id = $1 FOR SHARE`,
    [applicationId],
  );
  return rows[0]?.responsible_hr_id === hrId;
}

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
    // reason HR recorded (shown to HR only, AD-63). Ending, extending and transferring are below; reopening is not built.
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
    // AD-63 L2, NEW-35: extend an Active training to a later planned end date, with a mandatory reason; every extension
    // is kept (assignment_extensions, insert-only).
    method: 'POST',
    path: '/api/hr/assignments/:id/extend',
    policy: 'HR',
    async handle(c) {
      const body = await bindJson<{ endDate: string; reason: string }>(
        c.req.raw,
        extendAssignmentRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;
      const id = routeId(c);
      const { rows } = await c.var.db.query<{ status: string; end_date: string; version: string }>(
        'SELECT status, end_date::text, xmin::text AS version FROM assignments WHERE id = $1',
        [id],
      );
      const current = rows[0];
      if (!current) throw NotFoundError.for('Assignment', id);

      const extension = extendAssignment(body.value, { status: current.status, plannedEndDate: current.end_date });
      const now = c.var.deps.now();
      // One transaction: the history row first, then the end date only if nobody changed the assignment meanwhile
      // (xmin, else 409), so a conflict also discards the history row. Audited with the HR user as the actor.
      await c.var.db.transaction(c.var.actor, async (tx) => {
        await tx.query(
          `INSERT INTO assignment_extensions
             (id, assignment_id, previous_end_date, new_end_date, reason, extended_by_id, extended_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [uuidV7(now), id, current.end_date, extension.newEndDate, extension.reason, c.var.user!.id, now],
        );
        await updateOrConflict(
          tx,
          `UPDATE assignments SET end_date = $2 WHERE id = $1 AND status = 'Active' AND xmin = $3::xid`,
          [id, extension.newEndDate, current.version],
        );
        // AD-65: not while a transfer that takes effect today waits for the scheduled run. A scheduled transfer's
        // incoming assignment inherits the extended end date when it is executed.
        await assertNoDueTransfer(tx, id, now);
      });
      return json((await hrAssignments(c, id))[0]);
    },
  },
  {
    // AD-65 (revised): the current responsible HR (AD-64) decides to transfer an Active training to another mentor, who
    // holds the Employee role now and does not approve. Today: the decision is executed at once in the same transaction
    // (the outgoing assignment becomes Transferred and ends yesterday, the incoming one starts today with the same
    // planned end date, the link is recorded). A later date: the decision stays Pending and nothing else changes; the
    // scheduled job executes it on that date. Past dates are refused. At most one pending transfer per training (409).
    // Audited with the HR user as the actor. No e-mail or notification (none in PDF §7 for a transfer, AD-59).
    method: 'POST',
    path: '/api/hr/assignments/:id/transfer',
    policy: 'HR',
    async handle(c) {
      const body = await bindJson<{ employeeId: string; transferDate: string; reason: string }>(
        c.req.raw,
        transferAssignmentRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;
      const id = routeId(c);
      const hrId = c.var.user!.id;
      const { rows } = await c.var.db.query<{ application_id: string; responsible_hr_id: string }>(
        `SELECT s.application_id, ${CURRENT_RESPONSIBLE_HR_ID} AS responsible_hr_id
           FROM assignments s JOIN training_applications a ON a.id = s.application_id
          WHERE s.id = $1`,
        [id],
      );
      if (!rows[0]) throw NotFoundError.for('Assignment', id);
      if (rows[0].responsible_hr_id !== hrId) return notResponsible();

      const now = c.var.deps.now();
      const today = calendarDate(now);
      const outcome = await c.var.db.transaction(c.var.actor, async (tx) => {
        if (!(await isResponsibleHr(tx, rows[0]!.application_id, hrId))) return notResponsible();
        // The rules are checked against the assignment as locked here, so a concurrent change waits or is seen.
        const current = (await lockAssignment(tx, id))!;
        const decision = decideTransfer(
          {
            employeeId: parseGuid(body.value.employeeId),
            transferDate: body.value.transferDate,
            reason: body.value.reason,
          },
          {
            status: current.status,
            startDate: current.start_date,
            plannedEndDate: current.end_date,
            employeeId: current.employee_id,
          },
          today,
        );
        const { rows: pending } = await tx.query(
          "SELECT 1 FROM transfer_decisions WHERE application_id = $1 AND status = 'Pending'",
          [current.application_id],
        );
        if (pending.length > 0) {
          throw new StateConflictError(
            'assignment.transfer_pending',
            'A transfer of this training is already scheduled. Cancel it first to choose another one.',
          );
        }
        if (!(await holdsEmployeeRole(tx, decision.incomingEmployeeId))) {
          throw new DomainError(
            'assignment.transfer_mentor_not_employee',
            'The incoming mentor must currently hold the Employee role.',
          );
        }
        const pendingDecision = {
          id: uuidV7(now),
          incoming_employee_id: decision.incomingEmployeeId,
          effective_date: decision.effectiveDate,
          reason: decision.reason,
          decided_by_id: hrId,
        };
        // Pending first, so the unique index (one pending decision per application) also guards an immediate one.
        await tx.query(
          `INSERT INTO transfer_decisions
             (id, application_id, from_assignment_id, incoming_employee_id, effective_date, reason, decided_by_id,
              decided_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending')`,
          [
            pendingDecision.id,
            current.application_id,
            id,
            pendingDecision.incoming_employee_id,
            pendingDecision.effective_date,
            pendingDecision.reason,
            hrId,
            now,
          ],
        );
        if (decision.effectiveDate > today) return id;
        return applyTransfer(tx, pendingDecision, current, now);
      });
      if (outcome instanceof Response) return outcome;
      return json((await hrAssignments(c, outcome))[0]);
    },
  },
  {
    // AD-65 (revised): the current responsible HR cancels a pending transfer, with a mandatory reason. The decision is
    // kept (Cancelled, with who, when and why); to choose another date or mentor, HR then decides a new transfer.
    method: 'POST',
    path: '/api/hr/transfer-decisions/:id/cancel',
    policy: 'HR',
    async handle(c) {
      const body = await bindJson<{ reason: string }>(c.req.raw, cancelTransferRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const id = routeId(c);
      const hrId = c.var.user!.id;
      const reason = required(body.value.reason, 'Cancellation reason', ASSIGNMENT_END_REASON_MAX_LENGTH);
      const { rows } = await c.var.db.query<{
        application_id: string;
        from_assignment_id: string;
        responsible_hr_id: string;
      }>(
        `SELECT d.application_id, d.from_assignment_id, ${CURRENT_RESPONSIBLE_HR_ID} AS responsible_hr_id
           FROM transfer_decisions d JOIN training_applications a ON a.id = d.application_id
          WHERE d.id = $1`,
        [id],
      );
      const decision = rows[0];
      if (!decision) throw NotFoundError.for('TransferDecision', id);
      if (decision.responsible_hr_id !== hrId) return notResponsible();

      const now = c.var.deps.now();
      const refused = await c.var.db.transaction(c.var.actor, async (tx) => {
        if (!(await isResponsibleHr(tx, decision.application_id, hrId))) return notResponsible();
        await lockAssignment(tx, decision.from_assignment_id); // the same lock order as the scheduled job
        const { rows: locked } = await tx.query<{ status: string }>(
          'SELECT status FROM transfer_decisions WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (locked[0]?.status !== 'Pending') {
          throw new DomainError('transfer_decision.invalid_status', 'The transfer is no longer pending.');
        }
        await tx.query(
          `UPDATE transfer_decisions
              SET status = 'Cancelled', resolved_by_id = $2, resolution_reason = $3, resolved_at = $4
            WHERE id = $1 AND status = 'Pending'`,
          [id, hrId, reason, now],
        );
        return null;
      });
      if (refused) return refused;
      return json((await hrAssignments(c, decision.from_assignment_id))[0]);
    },
  },
  {
    // AD-65: the mentors HR may choose as the incoming mentor of a transfer: users who hold the Employee role now. Names
    // only.
    method: 'GET',
    path: '/api/hr/mentors',
    policy: 'HR',
    async handle(c) {
      const { rows } = await c.var.db.query<{ id: string; full_name: string }>(
        "SELECT id, full_name FROM employees WHERE role = 'Employee' ORDER BY full_name, id",
      );
      return json(rows.map((r) => ({ id: r.id, fullName: r.full_name })));
    },
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
  extensions: {
    previousEndDate: string;
    newEndDate: string;
    reason: string;
    extendedAt: string;
    extendedBy: string;
  }[];
  trainee_id: string;
  trainee_name: string | null;
  trainee_email: string;
  employee_id: string;
  employee_name: string;
  employee_email: string;
  field_name: string;
  can_transfer: boolean;
  can_cancel_transfer: boolean;
  transfer_decisions: {
    id: string;
    status: string;
    effectiveDate: string;
    incomingEmployeeName: string;
    reason: string;
    decidedBy: string;
    decidedAt: string;
    resolvedAt: string | null;
    resolvedBy: string | null;
    resolutionCode: string | null;
    resolutionReason: string | null;
  }[];
  transferred_from: { assignmentId: string; employeeName: string } | null;
  transferred_to: { assignmentId: string; employeeName: string } | null;
}

/**
 * HR's view of the assignments (all, or one), newest first, with the transfer decisions taken from each (AD-65: pending,
 * executed, cancelled or void, oldest first), the executed transfer links, and whether the signed-in HR may transfer it
 * (Active, no pending transfer, and they are the application's current responsible HR, AD-64) or cancel its pending
 * transfer (the same HR). The endpoints check the same themselves.
 */
async function hrAssignments(c: Context<AppEnv>, id: string | null = null) {
  const { rows } = await c.var.db.query<HrAssignmentRow>(
    `SELECT s.id, s.application_id, s.status, s.start_date::text, s.end_date::text, s.end_reason,
            coalesce((SELECT json_agg(json_build_object('previousEndDate', x.previous_end_date::text,
                                                        'newEndDate', x.new_end_date::text, 'reason', x.reason,
                                                        'extendedAt', x.extended_at, 'extendedBy', h.full_name)
                                      ORDER BY x.extended_at, x.id)
                        FROM assignment_extensions x JOIN employees h ON h.id = x.extended_by_id
                       WHERE x.assignment_id = s.id), '[]') AS extensions,
            t.id AS trainee_id, t.full_name AS trainee_name, t.email AS trainee_email,
            e.id AS employee_id, e.full_name AS employee_name, e.email AS employee_email, f.name AS field_name,
            (s.status = 'Active' AND ${CURRENT_RESPONSIBLE_HR_ID} = $2::uuid
               AND NOT EXISTS (SELECT 1 FROM transfer_decisions d
                                WHERE d.application_id = s.application_id AND d.status = 'Pending')) AS can_transfer,
            (${CURRENT_RESPONSIBLE_HR_ID} = $2::uuid
               AND EXISTS (SELECT 1 FROM transfer_decisions d
                            WHERE d.from_assignment_id = s.id AND d.status = 'Pending')) AS can_cancel_transfer,
            coalesce((SELECT json_agg(json_build_object('id', d.id, 'status', d.status,
                                                        'effectiveDate', d.effective_date::text,
                                                        'incomingEmployeeName', ie.full_name, 'reason', d.reason,
                                                        'decidedBy', dh.full_name, 'decidedAt', d.decided_at,
                                                        'resolvedAt', d.resolved_at, 'resolvedBy', rh.full_name,
                                                        'resolutionCode', d.resolution_code,
                                                        'resolutionReason', d.resolution_reason)
                                      ORDER BY d.decided_at, d.id)
                        FROM transfer_decisions d JOIN employees ie ON ie.id = d.incoming_employee_id
                        JOIN employees dh ON dh.id = d.decided_by_id
                        LEFT JOIN employees rh ON rh.id = d.resolved_by_id
                       WHERE d.from_assignment_id = s.id), '[]') AS transfer_decisions,
            (SELECT json_build_object('assignmentId', o.id, 'employeeName', oe.full_name)
               FROM assignment_transfers x JOIN assignments o ON o.id = x.from_assignment_id
               JOIN employees oe ON oe.id = o.employee_id
              WHERE x.to_assignment_id = s.id) AS transferred_from,
            (SELECT json_build_object('assignmentId', o.id, 'employeeName', oe.full_name)
               FROM assignment_transfers x JOIN assignments o ON o.id = x.to_assignment_id
               JOIN employees oe ON oe.id = o.employee_id
              WHERE x.from_assignment_id = s.id) AS transferred_to
       FROM assignments s JOIN employees e ON e.id = s.employee_id
       JOIN training_applications a ON a.id = s.application_id JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE ($1::uuid IS NULL OR s.id = $1)
      ORDER BY s.start_date DESC, s.created_at DESC`,
    [id, c.var.user!.id],
  );
  return rows.map((r) => ({
    id: r.id,
    applicationId: r.application_id,
    status: r.status,
    startDate: r.start_date,
    endDate: r.end_date,
    endReason: r.end_reason,
    extensions: r.extensions,
    trainee: { id: r.trainee_id, fullName: r.trainee_name, email: r.trainee_email },
    employee: { id: r.employee_id, fullName: r.employee_name, email: r.employee_email },
    fieldName: r.field_name,
    canTransfer: r.can_transfer,
    canCancelTransfer: r.can_cancel_transfer,
    transferDecisions: r.transfer_decisions,
    transferredFrom: r.transferred_from,
    transferredTo: r.transferred_to,
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
  const now = c.var.deps.now();
  await c.var.db.transaction(c.var.actor, async (tx) => {
    await updateOrConflict(
      tx,
      `UPDATE assignments SET status = $2, end_date = $3, end_reason = $4
        WHERE id = $1 AND status = 'Active' AND xmin = $5::xid`,
      [id, ending.status, ending.endDate, ending.reason, current.version],
    );
    // AD-65: not while a transfer that takes effect today waits for the scheduled run; a transfer scheduled for a later
    // date can no longer happen, so its decision is voided (kept, with the reason code).
    await assertNoDueTransfer(tx, id, now);
    await voidPendingTransfer(tx, id, now);
  });
  return json((await hrAssignments(c, id))[0]);
}
