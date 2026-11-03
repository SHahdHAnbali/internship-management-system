import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError } from '../../domain/errors';
import { parseGuid } from '../../domain/uuid';
import { json } from '../../http/problems';
import type { Route } from '../../http/routes';

/**
 * The monthly report (PDF §6 «التقرير الشهري»: everyone who was training during the month, with whom, in which field,
 * from when to when; for HR and the Admin). Read-only. As the PDF's technical note says, it is built from the
 * assignments and their recorded start and end dates: an assignment appears in every month its period overlaps, whatever
 * its status, so a trainee moved between employees appears as two rows. Filtered by field and employee (PDF §6 "every
 * report is filtered by period, field and employee"; the period is the month).
 */
interface MonthlyRow {
  id: string;
  trainee_name: string | null;
  employee_id: string;
  employee_name: string;
  field_id: string;
  field_name: string;
  start_date: string;
  end_date: string;
}

/** `YYYY-MM` → the first and last calendar day of that month, as dates (no time zone involved). */
export function monthBounds(value: string | undefined): { start: string; end: string } | null {
  const match = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/.exec(value ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}` };
}

/** An optional id filter: absent or empty means "all"; anything else must be a GUID. */
function optionalId(c: Context<AppEnv>, name: string): string | null {
  const value = c.req.query(name);
  if (!value) return null;
  const id = parseGuid(value);
  if (!id) throw new DomainError('validation.invalid', `${name} is not a valid id.`);
  return id;
}

async function monthlyReport(c: Context<AppEnv>) {
  const month = c.req.query('month');
  const bounds = monthBounds(month);
  if (!bounds) throw new DomainError('validation.invalid', 'The month must be given as YYYY-MM.');
  const fieldId = optionalId(c, 'fieldId');
  const employeeId = optionalId(c, 'employeeId');

  // Dates are compared and returned as SQL dates (text), never as JavaScript dates, so no calendar day shifts.
  const { rows } = await c.var.db.query<MonthlyRow>(
    `SELECT s.id, t.full_name AS trainee_name, e.id AS employee_id, e.full_name AS employee_name,
            f.id AS field_id, f.name AS field_name, s.start_date::text, s.end_date::text
       FROM assignments s JOIN employees e ON e.id = s.employee_id
       JOIN training_applications a ON a.id = s.application_id JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE s.start_date <= $2::date AND s.end_date >= $1::date
        AND ($3::uuid IS NULL OR f.id = $3) AND ($4::uuid IS NULL OR e.id = $4)
      ORDER BY s.start_date, t.full_name, s.created_at`,
    [bounds.start, bounds.end, fieldId, employeeId],
  );
  return json({
    month,
    monthStart: bounds.start,
    monthEnd: bounds.end,
    rows: rows.map((r) => ({
      assignmentId: r.id,
      traineeName: r.trainee_name,
      employee: { id: r.employee_id, fullName: r.employee_name },
      field: { id: r.field_id, name: r.field_name },
      startDate: r.start_date,
      endDate: r.end_date,
    })),
  });
}

/** The filter choices: the fields and employees that appear in recorded assignments, so every choice can match. */
async function monthlyReportFilters(c: Context<AppEnv>) {
  const fields = await c.var.db.query<{ id: string; name: string }>(
    `SELECT f.id, f.name FROM fields f
      WHERE EXISTS (SELECT 1 FROM assignments s JOIN training_applications a ON a.id = s.application_id
                     WHERE a.field_id = f.id)
      ORDER BY f.name`,
  );
  const employees = await c.var.db.query<{ id: string; full_name: string }>(
    `SELECT e.id, e.full_name FROM employees e
      WHERE EXISTS (SELECT 1 FROM assignments s WHERE s.employee_id = e.id)
      ORDER BY e.full_name`,
  );
  return json({
    fields: fields.rows,
    employees: employees.rows.map((e) => ({ id: e.id, fullName: e.full_name })),
  });
}

/** The same report in each area that the PDF gives it to: HR and the Admin (one exact role per route). */
export const reportRoutes: Route[] = (['HR', 'Admin'] as const).flatMap((role): Route[] => {
  const base = role === 'HR' ? '/api/hr/reports' : '/api/admin/reports';
  return [
    { method: 'GET', path: `${base}/monthly`, policy: role, handle: monthlyReport },
    { method: 'GET', path: `${base}/monthly/filters`, policy: role, handle: monthlyReportFilters },
  ];
});
