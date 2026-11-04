import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { json } from '../../http/problems';
import type { Route } from '../../http/routes';
import { optionalId } from './monthlyReport';

/**
 * The mentor profile (PDF §6 «ملف المدرّب»: how many each employee has trained, over time, and the average of their
 * evaluations; for HR, and each employee for themselves). Read-only. Built so far, from the stored assignments of every
 * status: the number of trainees each employee has had (distinct trainees, the PDF's «عدد من درّبهم») and the number of
 * assignment records (owner approval 2026-11-03; a trainee assigned twice to the same employee counts once and twice).
 * Not built: the average evaluation (no evaluations; N1, N2, Q11, NEW-03) and the breakdown "over time" (not defined).
 * HR sees every employee (those with the Employee role, and anyone else who has assignments); an employee sees only
 * themself, identified by the session. The Admin has no access: which reports the Admin sees beyond the PDF §6 table is
 * open (NEW-02).
 */
interface MentorRow {
  id: string;
  full_name: string;
  trainees: number;
  assignments: number;
}

const MENTOR_SELECT = `
  SELECT e.id, e.full_name, count(DISTINCT a.trainee_id)::int AS trainees, count(s.id)::int AS assignments
    FROM employees e
    LEFT JOIN assignments s ON s.employee_id = e.id
    LEFT JOIN training_applications a ON a.id = s.application_id`;

const toMentor = (r: MentorRow) => ({
  employee: { id: r.id, fullName: r.full_name },
  trainees: r.trainees,
  assignments: r.assignments,
});

/**
 * HR: every employee who mentors (the Employee role) or has mentored (has an assignment), with zero counts too.
 * `employeeId` (optional, PDF §6 employee filter) keeps only that employee's row of the same list: an id outside the
 * list (or unknown) gives no rows; an id that is not a GUID is a 400.
 */
async function allMentors(c: Context<AppEnv>) {
  const employeeId = optionalId(c, 'employeeId');
  const { rows } = await c.var.db.query<MentorRow>(
    `${MENTOR_SELECT}
      WHERE (e.role = 'Employee' OR EXISTS (SELECT 1 FROM assignments x WHERE x.employee_id = e.id))
        AND ($1::uuid IS NULL OR e.id = $1)
      GROUP BY e.id, e.full_name
      ORDER BY e.full_name, e.id`,
    [employeeId],
  );
  return json({ rows: rows.map(toMentor) });
}

/** Employee: their own profile only; the id comes from the session, never from the request. */
async function ownProfile(c: Context<AppEnv>) {
  const { rows } = await c.var.db.query<MentorRow>(
    `${MENTOR_SELECT}
      WHERE e.id = $1
      GROUP BY e.id, e.full_name`,
    [c.var.user!.id],
  );
  return json(toMentor(rows[0]!));
}

export const mentorProfileRoutes: Route[] = [
  { method: 'GET', path: '/api/hr/reports/mentor-profile', policy: 'HR', handle: allMentors },
  { method: 'GET', path: '/api/employee/reports/mentor-profile', policy: 'Employee', handle: ownProfile },
];
