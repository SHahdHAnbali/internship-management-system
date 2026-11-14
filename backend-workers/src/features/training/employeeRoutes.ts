import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError, NotFoundError } from '../../domain/errors';
import { required } from '../../domain/guard';
import { MENTOR_NOTE_MAX_LENGTH, parseDate, PROGRESS_NOTE_MAX_LENGTH } from '../../domain/training';
import { parseGuid, uuidV7 } from '../../domain/uuid';
import { bindJson, type RequestSchema } from '../../http/body';
import { endpointFailure, json, statusProblem } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';
import { EMPLOYEE_MAY_SEE_CV, IS_AVAILABLE } from './access';
import { mentorRequestSubmittedEmails, sendEventEmails } from '../notifications/eventEmails';
import { notifyEmployee } from '../notifications/notify';
import { fileLink } from './files';
import { eligibleResponsibleHr, type ResponsibleHrRecipient } from './responsibleHr';
import { assertNoDueTransfer } from './transfers';

/**
 * `/api/employee` (Employee role only; PDF §2, §4): the available trainees (accepted and not yet assigned), filterable
 * by field, university and period, with their CV; "I want to train them" with a short note, which waits for HR; and
 * "my trainees", current and previous, with periodic notes. An employee only ever sees their own requests,
 * assignments and notes.
 */
const mentorRequestBody: RequestSchema = {
  typeName: 'Ims.Application.Employee.MentorRequestRequest',
  properties: [
    { name: 'ApplicationId', kind: 'string', required: true, maxLength: 36 },
    { name: 'Note', kind: 'string', required: true, maxLength: MENTOR_NOTE_MAX_LENGTH },
  ],
};

const noteBody: RequestSchema = {
  typeName: 'Ims.Application.Employee.ProgressNoteRequest',
  properties: [{ name: 'Text', kind: 'string', required: true, maxLength: PROGRESS_NOTE_MAX_LENGTH }],
};

interface AvailableRow {
  id: string;
  full_name: string | null;
  university: string | null;
  major: string | null;
  study_year: string | null;
  field_id: string;
  field_name: string;
  available_from: string;
  available_to: string;
  hours: number;
  mandatory_for_university: boolean;
  has_cv: boolean;
}

export const employeeRoutes: Route[] = [
  {
    // The training fields, for the field filter.
    method: 'GET',
    path: '/api/employee/fields',
    policy: 'Employee',
    async handle(c) {
      const { rows } = await c.var.db.query<{ id: string; name: string }>('SELECT id, name FROM fields ORDER BY name');
      return json(rows);
    },
  },
  {
    // Contact details are not shown here: the list is for choosing whom to mentor, and HR coordinates (PDF §4).
    method: 'GET',
    path: '/api/employee/available-trainees',
    policy: 'Employee',
    async handle(c) {
      const fieldId = parseGuid(c.req.query('fieldId') ?? '');
      const university = c.req.query('university')?.trim() || null;
      const from = parseDate(c.req.query('from'));
      const to = parseDate(c.req.query('to'));
      const { rows } = await c.var.db.query<AvailableRow>(
        `SELECT a.id, t.full_name, t.university, t.major, t.study_year, f.id AS field_id, f.name AS field_name,
                a.available_from::text, a.available_to::text, a.hours, a.mandatory_for_university,
                EXISTS (SELECT 1 FROM application_attachments x WHERE x.application_id = a.id AND x.kind = 'Cv') AS has_cv
           FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
          WHERE ${IS_AVAILABLE}
            AND ($1::uuid IS NULL OR a.field_id = $1)
            AND ($2::text IS NULL OR t.university ILIKE '%' || $2 || '%')
            AND ($3::date IS NULL OR a.available_to >= $3)
            AND ($4::date IS NULL OR a.available_from <= $4)
          ORDER BY a.available_from, t.full_name`,
        [fieldId, university, from, to],
      );
      return json(
        rows.map((r) => ({
          applicationId: r.id,
          trainee: { fullName: r.full_name, university: r.university, major: r.major, studyYear: r.study_year },
          field: { id: r.field_id, name: r.field_name },
          availableFrom: r.available_from,
          availableTo: r.available_to,
          hours: r.hours,
          mandatoryForUniversity: r.mandatory_for_university,
          hasCv: r.has_cv,
        })),
      );
    },
  },
  {
    // The CV of an application (`:id`) the employee may see (see EMPLOYEE_MAY_SEE_CV), through a temporary link.
    method: 'POST',
    path: '/api/employee/applications/:id/cv-link',
    policy: 'Employee',
    async handle(c) {
      const { rows } = await c.var.db.query<{ id: string }>(
        `SELECT x.id FROM application_attachments x JOIN training_applications a ON a.id = x.application_id
          WHERE a.id = $1 AND x.kind = 'Cv' AND ${EMPLOYEE_MAY_SEE_CV} ORDER BY x.uploaded_at DESC LIMIT 1`,
        [routeId(c), c.var.user!.id],
      );
      if (!rows[0]) return statusProblem(404, c.var.traceId, true);
      return json(await fileLink(c, rows[0].id, c.var.user!.id));
    },
  },
  {
    // "I want to train them" (PDF §4): recorded for the signed-in employee; it waits for HR, nothing starts yet.
    method: 'POST',
    path: '/api/employee/mentor-requests',
    policy: 'Employee',
    async handle(c) {
      const body = await bindJson<{ applicationId: string; note: string }>(c.req.raw, mentorRequestBody, c.var.traceId);
      if (!body.ok) return body.response;
      const applicationId = parseGuid(body.value.applicationId);
      if (!applicationId) throw new DomainError('validation.required', 'Application is required.');
      const note = required(body.value.note, 'Note', MENTOR_NOTE_MAX_LENGTH);

      const { rows } = await c.var.db.query(
        `SELECT 1 FROM training_applications a WHERE a.id = $1 AND ${IS_AVAILABLE}`,
        [applicationId],
      );
      if (rows.length === 0) {
        throw new DomainError('mentor_request.not_available', 'This trainee is no longer available for training.');
      }

      const now = c.var.deps.now();
      const id = uuidV7(now);
      let recipient: ResponsibleHrRecipient | null = null;
      await c.var.db.transaction(c.var.actor, async (tx) => {
        await tx.query(
          `INSERT INTO mentor_requests (id, employee_id, application_id, note, status, requested_at)
           VALUES ($1, $2, $3, $4, 'Pending', $5)`,
          [id, c.var.user!.id, applicationId, note, now],
        );
        // PDF §7 "employee requested to train a trainee", in-app: only to the application's current responsible HR
        // while they hold the HR role (AD-64, supersedes Q41/C1 for this event). None eligible: the request is kept and
        // nobody is notified, never the former HR and never every HR user.
        recipient = await eligibleResponsibleHr(tx, applicationId);
        if (recipient) await notifyEmployee(tx, recipient.id, 'MentorRequestSubmitted', id, now);
      });
      // The same event by e-mail, to the same user resolved in the transaction (AD-64, supersedes NEW-24 for this
      // event), after the commit (best effort, if enabled).
      const emailTo: ResponsibleHrRecipient | null = recipient;
      if (emailTo) await sendEventEmails(c, (q) => mentorRequestSubmittedEmails(q, id, emailTo));
      return json({ id, status: 'Pending', note, requestedAt: now }, 201);
    },
  },
  {
    // The employee's own requests and HR's decisions on them.
    method: 'GET',
    path: '/api/employee/mentor-requests',
    policy: 'Employee',
    async handle(c) {
      const { rows } = await c.var.db.query<{
        id: string;
        application_id: string;
        status: string;
        note: string;
        requested_at: Date;
        decided_at: Date | null;
        rejection_reason: string | null;
        trainee_name: string | null;
        field_name: string;
      }>(
        `SELECT r.id, r.application_id, r.status, r.note, r.requested_at, r.decided_at, r.rejection_reason,
                t.full_name AS trainee_name,
                f.name AS field_name
           FROM mentor_requests r JOIN training_applications a ON a.id = r.application_id
           JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
          WHERE r.employee_id = $1 ORDER BY r.requested_at DESC`,
        [c.var.user!.id],
      );
      return json(
        rows.map((r) => ({
          id: r.id,
          applicationId: r.application_id,
          status: r.status,
          note: r.note,
          requestedAt: r.requested_at,
          decidedAt: r.decided_at,
          // AD-67: set only when the request was rejected because HR assigned the trainee directly.
          rejectionReason: r.rejection_reason,
          traineeName: r.trainee_name,
          fieldName: r.field_name,
        })),
      );
    },
  },
  {
    // My trainees (PDF §4): this employee's assignments, current (Active) and previous.
    method: 'GET',
    path: '/api/employee/trainees',
    policy: 'Employee',
    async handle(c) {
      const { rows } = await c.var.db.query<{
        id: string;
        application_id: string;
        status: string;
        start_date: string;
        end_date: string;
        full_name: string | null;
        university: string | null;
        major: string | null;
        field_name: string;
        can_read_earlier_notes: boolean;
      }>(
        `SELECT s.id, s.application_id, s.status, s.start_date::text, s.end_date::text, t.full_name, t.university, t.major,
                f.name AS field_name, ${IS_LATEST_WITH_EARLIER} AS can_read_earlier_notes
           FROM assignments s JOIN training_applications a ON a.id = s.application_id
           JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
          WHERE s.employee_id = $1 ORDER BY s.start_date DESC`,
        [c.var.user!.id],
      );
      return json(
        rows.map((r) => ({
          id: r.id,
          applicationId: r.application_id,
          status: r.status,
          startDate: r.start_date,
          endDate: r.end_date,
          trainee: { fullName: r.full_name, university: r.university, major: r.major },
          fieldName: r.field_name,
          canReadEarlierNotes: r.can_read_earlier_notes,
        })),
      );
    },
  },
  {
    // AD-65: the earlier mentors' progress notes of the same training, read-only, for the mentor of its latest assignment
    // (nothing transferred out of it), also after the training has ended. An earlier mentor keeps reading only their own
    // notes (the endpoint above); nobody else reads these.
    method: 'GET',
    path: '/api/employee/assignments/:id/earlier-notes',
    policy: 'Employee',
    async handle(c) {
      const assignment = await ownAssignment(c, routeId(c));
      const { rows: latest } = await c.var.db.query<{ latest: boolean }>(
        'SELECT NOT EXISTS (SELECT 1 FROM assignment_transfers x WHERE x.from_assignment_id = $1) AS latest',
        [assignment.id],
      );
      if (!latest[0]?.latest) {
        return endpointFailure(
          403,
          'progress_note.not_latest_mentor',
          "Only the mentor of the training's latest assignment may read the earlier mentors' notes.",
        );
      }
      const { rows } = await c.var.db.query<{
        id: string;
        written_at: Date;
        text: string;
        author_name: string;
        start_date: string;
        end_date: string;
        mentor_name: string;
      }>(
        `SELECT n.id, n.written_at, n.text, au.full_name AS author_name, p.start_date::text, p.end_date::text,
                pe.full_name AS mentor_name
           FROM progress_notes n JOIN assignments p ON p.id = n.assignment_id
           JOIN employees au ON au.id = n.author_id JOIN employees pe ON pe.id = p.employee_id
          WHERE p.application_id = (SELECT application_id FROM assignments WHERE id = $1) AND p.id <> $1
          ORDER BY n.written_at, n.id`,
        [assignment.id],
      );
      return json(
        rows.map((n) => ({
          id: n.id,
          writtenAt: n.written_at,
          text: n.text,
          authorName: n.author_name,
          assignment: { startDate: n.start_date, endDate: n.end_date, mentorName: n.mentor_name },
        })),
      );
    },
  },
  {
    method: 'GET',
    path: '/api/employee/assignments/:id/notes',
    policy: 'Employee',
    async handle(c) {
      const assignment = await ownAssignment(c, routeId(c));
      const { rows } = await c.var.db.query<{ id: string; written_at: Date; text: string; author_name: string }>(
        `SELECT n.id, n.written_at, n.text, e.full_name AS author_name
           FROM progress_notes n JOIN employees e ON e.id = n.author_id
          WHERE n.assignment_id = $1 ORDER BY n.written_at DESC`,
        [assignment.id],
      );
      return json(rows.map((n) => ({ id: n.id, writtenAt: n.written_at, text: n.text, authorName: n.author_name })));
    },
  },
  {
    // A periodic note (PDF §4), for the employee's own training while it is running.
    method: 'POST',
    path: '/api/employee/assignments/:id/notes',
    policy: 'Employee',
    async handle(c) {
      const body = await bindJson<{ text: string }>(c.req.raw, noteBody, c.var.traceId);
      if (!body.ok) return body.response;
      const text = required(body.value.text, 'Note', PROGRESS_NOTE_MAX_LENGTH);
      const assignment = await ownAssignment(c, routeId(c));
      if (assignment.status !== 'Active') {
        throw new DomainError('progress_note.not_active', 'Notes can only be written while the training is active.');
      }

      const now = c.var.deps.now();
      const id = uuidV7(now);
      await c.var.db.transaction(c.var.actor, async (tx) => {
        // AD-65: under a shared lock, so a transfer executed meanwhile is seen (the note would belong to an assignment
        // that has ended), and never while a transfer that takes effect today waits for the scheduled run.
        const { rows } = await tx.query<{ status: string }>('SELECT status FROM assignments WHERE id = $1 FOR SHARE', [
          assignment.id,
        ]);
        if (rows[0]?.status !== 'Active') {
          throw new DomainError('progress_note.not_active', 'Notes can only be written while the training is active.');
        }
        await assertNoDueTransfer(tx, assignment.id, now);
        await tx.query(
          'INSERT INTO progress_notes (id, assignment_id, author_id, written_at, text) VALUES ($1, $2, $3, $4, $5)',
          [id, assignment.id, c.var.user!.id, now, text],
        );
      });
      return json({ id, writtenAt: now, text }, 201);
    },
  },
];

/**
 * AD-65: `s` is the latest assignment of its training (nothing was transferred out of it) and the training has earlier
 * assignments, so its mentor may read the earlier mentors' notes.
 */
const IS_LATEST_WITH_EARLIER = `(NOT EXISTS (SELECT 1 FROM assignment_transfers x WHERE x.from_assignment_id = s.id)
  AND EXISTS (SELECT 1 FROM assignments p WHERE p.application_id = s.application_id AND p.id <> s.id))`;

/** The signed-in employee's own assignment; another employee's is reported as not found. */
async function ownAssignment(c: Context<AppEnv>, id: string) {
  const { rows } = await c.var.db.query<{ id: string; status: string }>(
    'SELECT id, status FROM assignments WHERE id = $1 AND employee_id = $2',
    [id, c.var.user!.id],
  );
  if (!rows[0]) throw NotFoundError.for('Assignment', id);
  return rows[0];
}
