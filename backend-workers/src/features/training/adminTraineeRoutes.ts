import { json } from '../../http/problems';
import type { Route } from '../../http/routes';

/**
 * `/api/admin/accepted-trainees` (Admin role only; PDF §2: the Admin "sees the accepted trainees"). Read-only: the
 * applications HR accepted (status Accepted, AD-47), with the trainee's profile and any assignments of that
 * application as recorded. Nothing is derived beyond what the records say.
 */
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
}

export const adminTraineeRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/admin/accepted-trainees',
    policy: 'Admin',
    async handle(c) {
      const { rows } = await c.var.db.query<AcceptedRow>(
        `SELECT a.id, t.full_name, t.university, t.major, t.study_year, f.name AS field_name,
                a.available_from::text, a.available_to::text, a.hours, a.mandatory_for_university, a.decided_at,
                coalesce((SELECT json_agg(json_build_object('employeeName', e.full_name, 'status', s.status,
                                                            'startDate', s.start_date, 'endDate', s.end_date)
                                          ORDER BY s.start_date, s.created_at)
                            FROM assignments s JOIN employees e ON e.id = s.employee_id
                           WHERE s.application_id = a.id), '[]') AS assignments
           FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
          WHERE a.status = 'Accepted'
          ORDER BY a.decided_at DESC NULLS LAST, t.full_name`,
      );
      return json(
        rows.map((r) => ({
          applicationId: r.id,
          trainee: { fullName: r.full_name, university: r.university, major: r.major, studyYear: r.study_year },
          fieldName: r.field_name,
          availableFrom: r.available_from,
          availableTo: r.available_to,
          hours: r.hours,
          mandatoryForUniversity: r.mandatory_for_university,
          acceptedAt: r.decided_at,
          assignments: r.assignments,
        })),
      );
    },
  },
];
