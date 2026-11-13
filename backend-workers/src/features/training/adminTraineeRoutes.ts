import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError, NotFoundError } from '../../domain/errors';
import { parseGuid, uuidV7 } from '../../domain/uuid';
import { bindJson, type RequestSchema } from '../../http/body';
import { json } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';
import { CURRENT_RESPONSIBLE_HR_ID } from './responsibleHr';

/**
 * `/api/admin/accepted-trainees` (Admin role only; PDF §2: the Admin "sees the accepted trainees"): the applications HR
 * accepted (status Accepted, AD-47), with the trainee's profile and any assignments of that application as recorded,
 * and the responsible HR (AD-64): the HR member who accepted it, the current responsible HR and whether they still hold
 * the HR role, and every replacement an Admin appointed. Only the Admin may appoint a replacement, and only a user who
 * holds the HR role now; each appointment is kept (insert-only `responsible_hr_changes`), the accepting HR too.
 */
interface StaffRef {
  id: string;
  fullName: string;
}

interface AcceptedRow {
  id: string;
  full_name: string | null;
  university: string | null;
  major: string | null;
  study_year: string | null;
  field_name: string;
  available_from: string;
  available_to: string;
  hours: number;
  mandatory_for_university: boolean;
  decided_at: Date | null;
  assignments: { employeeName: string; status: string; startDate: string; endDate: string }[];
  accepted_by: StaffRef;
  current_hr: StaffRef & { role: string };
  hr_changes: { sequence: number; hr: StaffRef; changedBy: string; changedAt: string }[];
}

// AD-64: the Admin appoints a replacement responsible HR.
const appointResponsibleHrRequest: RequestSchema = {
  typeName: 'Ims.Application.Admin.AppointResponsibleHrRequest',
  properties: [{ name: 'HrId', kind: 'string', required: true, maxLength: 36 }],
};

async function acceptedTrainees(c: Context<AppEnv>, applicationId: string | null = null) {
  const { rows } = await c.var.db.query<AcceptedRow>(
    `SELECT a.id, t.full_name, t.university, t.major, t.study_year, f.name AS field_name,
            a.available_from::text, a.available_to::text, a.hours, a.mandatory_for_university, a.decided_at,
            coalesce((SELECT json_agg(json_build_object('employeeName', e.full_name, 'status', s.status,
                                                        'startDate', s.start_date, 'endDate', s.end_date)
                                      ORDER BY s.start_date, s.created_at)
                        FROM assignments s JOIN employees e ON e.id = s.employee_id
                       WHERE s.application_id = a.id), '[]') AS assignments,
            json_build_object('id', d.id, 'fullName', d.full_name) AS accepted_by,
            (SELECT json_build_object('id', h.id, 'fullName', h.full_name, 'role', h.role)
               FROM employees h WHERE h.id = ${CURRENT_RESPONSIBLE_HR_ID}) AS current_hr,
            coalesce((SELECT json_agg(json_build_object('sequence', r.sequence,
                                                        'hr', json_build_object('id', h.id, 'fullName', h.full_name),
                                                        'changedBy', b.full_name, 'changedAt', r.changed_at)
                                      ORDER BY r.sequence)
                        FROM responsible_hr_changes r JOIN employees h ON h.id = r.hr_id
                        JOIN employees b ON b.id = r.changed_by_id
                       WHERE r.application_id = a.id), '[]') AS hr_changes
       FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
       JOIN employees d ON d.id = a.decided_by_id
      WHERE a.status = 'Accepted' AND ($1::uuid IS NULL OR a.id = $1::uuid)
      ORDER BY a.decided_at DESC NULLS LAST, t.full_name`,
    [applicationId],
  );
  return rows.map((r) => ({
    applicationId: r.id,
    trainee: { fullName: r.full_name, university: r.university, major: r.major, studyYear: r.study_year },
    fieldName: r.field_name,
    availableFrom: r.available_from,
    availableTo: r.available_to,
    hours: r.hours,
    mandatoryForUniversity: r.mandatory_for_university,
    acceptedAt: r.decided_at,
    assignments: r.assignments,
    responsibleHr: {
      acceptedBy: r.accepted_by,
      current: { id: r.current_hr.id, fullName: r.current_hr.fullName, isHr: r.current_hr.role === 'HR' },
      changes: r.hr_changes,
    },
  }));
}

export const adminTraineeRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/admin/accepted-trainees',
    policy: 'Admin',
    handle: async (c) => json(await acceptedTrainees(c)),
  },
  {
    // AD-64: appoint a replacement responsible HR for an accepted application. The chosen user must hold the HR role
    // now. Appointing the user who is already the current responsible HR records nothing.
    method: 'PUT',
    path: '/api/admin/accepted-trainees/:id/responsible-hr',
    policy: 'Admin',
    async handle(c) {
      const body = await bindJson<{ hrId: string }>(c.req.raw, appointResponsibleHrRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const id = routeId(c);
      const hrId = parseGuid(body.value.hrId);
      if (!hrId) throw new DomainError('validation.required', 'The responsible HR is required.');

      await c.var.db.transaction(c.var.actor, async (tx) => {
        // Lock the application, so appointments for it run one at a time and each sees the one before it.
        const { rows: applications } = await tx.query<{ status: string }>(
          'SELECT status FROM training_applications WHERE id = $1 FOR NO KEY UPDATE',
          [id],
        );
        const application = applications[0];
        if (!application) throw NotFoundError.for('TrainingApplication', id);
        if (application.status !== 'Accepted') {
          throw new DomainError(
            'application.invalid_status',
            'A responsible HR can be appointed only for an accepted application.',
          );
        }
        // FOR SHARE: a concurrent role change of the chosen user waits for this appointment (and vice versa).
        const { rows: candidates } = await tx.query<{ role: string }>(
          'SELECT role FROM employees WHERE id = $1 FOR SHARE',
          [hrId],
        );
        if (candidates[0]?.role !== 'HR') {
          throw new DomainError('responsible_hr.not_hr', 'The responsible HR must currently hold the HR role.');
        }
        const { rows: state } = await tx.query<{ current_hr_id: string; last_sequence: number }>(
          `SELECT ${CURRENT_RESPONSIBLE_HR_ID} AS current_hr_id,
                  coalesce((SELECT max(r.sequence) FROM responsible_hr_changes r WHERE r.application_id = a.id), 0)
                    AS last_sequence
             FROM training_applications a WHERE a.id = $1`,
          [id],
        );
        const { current_hr_id: currentHrId, last_sequence: lastSequence } = state[0]!;
        if (currentHrId === hrId) return; // already responsible: nothing to record
        const now = c.var.deps.now();
        await tx.query(
          `INSERT INTO responsible_hr_changes (id, application_id, sequence, hr_id, changed_by_id, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uuidV7(now), id, lastSequence + 1, hrId, c.var.user!.id, now],
        );
      });
      return json((await acceptedTrainees(c, id))[0]);
    },
  },
];
