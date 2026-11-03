import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError } from '../../domain/errors';
import { parseGuid } from '../../domain/uuid';
import { json } from '../../http/problems';
import type { Route } from '../../http/routes';

/**
 * The fields report (PDF §6 «تقرير المجالات»: the number of applications, accepted and completed for each field; for HR
 * and the Admin). Read-only. Built so far: for every field (including fields without applications), the number of
 * applications and the number whose status is Accepted (AD-47). Applications are counted, not trainees, so a trainee
 * with two applications counts twice. The "completed" count is not given: when a training counts as completed is not
 * decided (decisions.md L1). The period and employee filters are not given either: what they would mean for application
 * counts is not decided. The field filter keeps only that field's row.
 */
async function fieldsReport(c: Context<AppEnv>) {
  const field = c.req.query('fieldId');
  const fieldId = field ? parseGuid(field) : null;
  if (field && !fieldId) throw new DomainError('validation.invalid', 'fieldId is not a valid id.');

  const { rows } = await c.var.db.query<{ id: string; name: string; applications: number; accepted: number }>(
    `SELECT f.id, f.name, count(a.id)::int AS applications,
            count(a.id) FILTER (WHERE a.status = 'Accepted')::int AS accepted
       FROM fields f LEFT JOIN training_applications a ON a.field_id = f.id
      WHERE $1::uuid IS NULL OR f.id = $1
      GROUP BY f.id, f.name
      ORDER BY f.name`,
    [fieldId],
  );
  return json({
    rows: rows.map((r) => ({ field: { id: r.id, name: r.name }, applications: r.applications, accepted: r.accepted })),
  });
}

/** The same report in each area the PDF gives it to: HR and the Admin (one exact role per route). */
export const fieldsReportRoutes: Route[] = (['HR', 'Admin'] as const).map(
  (role): Route => ({
    method: 'GET',
    path: role === 'HR' ? '/api/hr/reports/fields' : '/api/admin/reports/fields',
    policy: role,
    handle: fieldsReport,
  }),
);
