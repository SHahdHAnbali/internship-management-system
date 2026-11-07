import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { updateOrConflict, type Queryable } from '../../db';
import {
  CRITERION_NAME_MAX_LENGTH,
  FIELD_DESCRIPTION_MAX_LENGTH,
  FIELD_NAME_MAX_LENGTH,
  criterionValues,
  fieldValues,
  notificationIntervals,
  staffRole,
  type NotificationIntervals,
} from '../../domain/admin';
import { DomainError, NotFoundError } from '../../domain/errors';
import { uuidV7 } from '../../domain/uuid';
import { bindJson, type RequestSchema, type RoleValue } from '../../http/body';
import { endpointFailure, json, statusProblem } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';

/**
 * The Admin module (`/api/admin`, Admin role only): training fields, evaluation criteria and weights, users and roles,
 * notification intervals (PDF §2, §4, §7). Mirrors Ims.Api.Controllers.Admin and Ims.Application.Admin.
 */
const createFieldRequest: RequestSchema = {
  typeName: 'Ims.Application.Admin.Fields.CreateFieldRequest',
  properties: [
    { name: 'Name', kind: 'string', required: true, maxLength: FIELD_NAME_MAX_LENGTH },
    { name: 'Description', kind: 'string', maxLength: FIELD_DESCRIPTION_MAX_LENGTH },
  ],
};

const updateFieldRequest: RequestSchema = {
  typeName: 'Ims.Application.Admin.Fields.UpdateFieldRequest',
  properties: [...createFieldRequest.properties, { name: 'IsActive', kind: 'bool' }],
};

const saveCriterionRequest: RequestSchema = {
  typeName: 'Ims.Application.Admin.EvaluationCriteria.SaveEvaluationCriterionRequest',
  properties: [
    { name: 'Name', kind: 'string', required: true, maxLength: CRITERION_NAME_MAX_LENGTH },
    { name: 'Weight', kind: 'decimal', range: { min: 0.0001, max: 99999, minText: '0.0001', maxText: '99999' } },
    { name: 'SortOrder', kind: 'int' },
  ],
};

const changeRoleRequest: RequestSchema = {
  typeName: 'Ims.Application.Admin.Users.ChangeUserRoleRequest',
  properties: [{ name: 'Role', kind: 'role' }],
};

const days = { min: 1, max: 365, minText: '1', maxText: '365' };
const notificationSettingsRequest: RequestSchema = {
  typeName: 'Ims.Application.Admin.Settings.NotificationSettingsDto',
  properties: [
    { name: 'TrainingEndingNoticeDays', kind: 'int', range: days },
    { name: 'LateEvaluationReminderDays', kind: 'int', range: days },
    { name: 'PendingRequestAlertDays', kind: 'int', range: days },
  ],
};

interface FieldRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  version: string;
}

interface CriterionRow {
  id: string;
  name: string;
  weight: string;
  sort_order: number;
  version: string;
}

interface EmployeeRow {
  id: string;
  full_name: string;
  email: string;
  department: string | null;
  role: string;
  version: string;
}

export const adminRoutes: Route[] = [
  // ── Fields: activated/deactivated, never deleted; names unique ignoring case (409 on a duplicate) ──
  {
    method: 'GET',
    path: '/api/admin/fields',
    policy: 'Admin',
    async handle(c) {
      const { rows } = await c.var.db.query<FieldRow>(
        'SELECT id, name, description, is_active FROM fields ORDER BY name',
      );
      return json(rows.map((f) => ({ id: f.id, name: f.name, description: f.description, isActive: f.is_active })));
    },
  },
  {
    method: 'POST',
    path: '/api/admin/fields',
    policy: 'Admin',
    async handle(c) {
      const body = await bindJson<{ name: string; description: string | null }>(
        c.req.raw,
        createFieldRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;

      const field = { id: uuidV7(c.var.deps.now()), ...fieldValues(body.value.name, body.value.description, true) };
      await c.var.db.transaction(c.var.actor, (tx) =>
        tx.query('INSERT INTO fields (id, name, description, is_active) VALUES ($1, $2, $3, $4)', [
          field.id,
          field.name,
          field.description,
          field.isActive,
        ]),
      );
      return json(field, 201, { Location: `/api/admin/fields/${field.id}` });
    },
  },
  {
    method: 'PUT',
    path: '/api/admin/fields/:id',
    policy: 'Admin',
    async handle(c) {
      const id = routeId(c);
      const body = await bindJson<{ name: string; description: string | null; isActive: boolean }>(
        c.req.raw,
        updateFieldRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;

      const current = await single<FieldRow>(
        c.var.db,
        'SELECT id, name, description, is_active, xmin::text AS version FROM fields WHERE id = $1',
        id,
        'Field',
      );
      const values = fieldValues(body.value.name, body.value.description, body.value.isActive);
      if (
        values.name !== current.name ||
        values.description !== current.description ||
        values.isActive !== current.is_active
      ) {
        await c.var.db.transaction(c.var.actor, (tx) =>
          updateOrConflict(
            tx,
            'UPDATE fields SET name = $1, description = $2, is_active = $3 WHERE id = $4 AND xmin = $5::xid',
            [values.name, values.description, values.isActive, id, current.version],
          ),
        );
      }

      return json({ id, ...values });
    },
  },

  // ── Evaluation criteria: name, weight (> 0), order ──
  {
    method: 'GET',
    path: '/api/admin/evaluation-criteria',
    policy: 'Admin',
    async handle(c) {
      const { rows } = await c.var.db.query<CriterionRow>(
        'SELECT id, name, weight, sort_order FROM evaluation_criteria ORDER BY sort_order, name',
      );
      return json(rows.map((r) => ({ id: r.id, name: r.name, weight: Number(r.weight), sortOrder: r.sort_order })));
    },
  },
  {
    method: 'POST',
    path: '/api/admin/evaluation-criteria',
    policy: 'Admin',
    async handle(c) {
      const body = await bindJson<{ name: string; weight: number; sortOrder: number }>(
        c.req.raw,
        saveCriterionRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;

      const criterion = {
        id: uuidV7(c.var.deps.now()),
        ...criterionValues(body.value.name, body.value.weight, body.value.sortOrder),
      };
      await c.var.db.transaction(c.var.actor, (tx) =>
        tx.query('INSERT INTO evaluation_criteria (id, name, weight, sort_order) VALUES ($1, $2, $3, $4)', [
          criterion.id,
          criterion.name,
          criterion.weight,
          criterion.sortOrder,
        ]),
      );
      return json(criterion, 201, { Location: `/api/admin/evaluation-criteria/${criterion.id}` });
    },
  },
  {
    method: 'PUT',
    path: '/api/admin/evaluation-criteria/:id',
    policy: 'Admin',
    async handle(c) {
      const id = routeId(c);
      const body = await bindJson<{ name: string; weight: number; sortOrder: number }>(
        c.req.raw,
        saveCriterionRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;

      const current = await single<CriterionRow>(
        c.var.db,
        'SELECT id, name, weight, sort_order, xmin::text AS version FROM evaluation_criteria WHERE id = $1',
        id,
        'EvaluationCriterion',
      );
      const values = criterionValues(body.value.name, body.value.weight, body.value.sortOrder);
      if (
        values.name !== current.name ||
        values.weight !== Number(current.weight) ||
        values.sortOrder !== current.sort_order
      ) {
        await c.var.db.transaction(c.var.actor, (tx) =>
          updateOrConflict(
            tx,
            'UPDATE evaluation_criteria SET name = $1, weight = $2, sort_order = $3 WHERE id = $4 AND xmin = $5::xid',
            [values.name, values.weight, values.sortOrder, id, current.version],
          ),
        );
      }

      return json({ id, ...values });
    },
  },

  // ── Users and roles: accounts are created on first Google sign-in as Employee ──
  {
    method: 'GET',
    path: '/api/admin/users',
    policy: 'Admin',
    async handle(c) {
      const { rows } = await c.var.db.query<EmployeeRow>(
        'SELECT id, full_name, email, department, role FROM employees ORDER BY full_name',
      );
      return json(rows.map(toUser));
    },
  },
  {
    method: 'PUT',
    path: '/api/admin/users/:id/role',
    policy: 'Admin',
    async handle(c) {
      const id = routeId(c);
      const body = await bindJson<{ role: RoleValue }>(c.req.raw, changeRoleRequest, c.var.traceId);
      if (!body.ok) return body.response;

      // Owner decisions (2026-11-07): an Admin never changes their own role (AUD-02); an Admin may change another
      // Admin's role (AUD-03) as long as at least one Admin remains (AUD-01).
      const actorId = c.var.user!.id;
      if (id === actorId) {
        return endpointFailure(403, 'employee.self_role_change', 'An Admin cannot change their own role.');
      }

      return c.var.db.transaction(c.var.actor, async (tx) => {
        // Every role change first locks the Admin rows, so changes run one at a time across Worker instances and each
        // one sees the result of the one before it. NO KEY UPDATE does not block sign-ins (their foreign keys take KEY
        // SHARE). This statement waits for the lock, then returns only the rows that are still Admin.
        const { rows: admins } = await tx.query<{ id: string }>(
          "SELECT id FROM employees WHERE role = 'Admin' ORDER BY id FOR NO KEY UPDATE",
        );
        const employee = await single<EmployeeRow>(
          tx,
          'SELECT id, full_name, email, department, role, xmin::text AS version FROM employees WHERE id = $1 FOR NO KEY UPDATE',
          id,
          'Employee',
        );
        const requested = body.value.role;
        if (requested === 'invalid') {
          throw new DomainError('employee.invalid_role', "A staff member's role must be Employee, HR or Admin.");
        }

        const role = staffRole(requested);
        if (employee.role === 'Admin' && role !== 'Admin' && admins.every((admin) => admin.id === id)) {
          return endpointFailure(409, 'employee.last_admin', 'This change would leave the system with no Admin.');
        }
        // The caller passed the Admin check before the wait; another Admin may have changed their role during it.
        if (!admins.some((admin) => admin.id === actorId)) return statusProblem(403, c.var.traceId, true);

        if (role !== employee.role) {
          await updateOrConflict(tx, 'UPDATE employees SET role = $1 WHERE id = $2 AND xmin = $3::xid', [
            role,
            id,
            employee.version,
          ]);
        }

        return json(toUser({ ...employee, role }));
      });
    },
  },

  // ── Notification intervals (PDF §7: 7 / 3 / 5 days) ──
  {
    method: 'GET',
    path: '/api/admin/settings/notifications',
    policy: 'Admin',
    async handle(c) {
      return json(await loadIntervals(c));
    },
  },
  {
    method: 'PUT',
    path: '/api/admin/settings/notifications',
    policy: 'Admin',
    async handle(c) {
      const body = await bindJson<NotificationIntervals>(c.req.raw, notificationSettingsRequest, c.var.traceId);
      if (!body.ok) return body.response;

      const current = await loadIntervals(c);
      const values = notificationIntervals(body.value);
      if (
        values.trainingEndingNoticeDays !== current.trainingEndingNoticeDays ||
        values.lateEvaluationReminderDays !== current.lateEvaluationReminderDays ||
        values.pendingRequestAlertDays !== current.pendingRequestAlertDays
      ) {
        // A single row, without a concurrency token (as in the C# model).
        await c.var.db.transaction(c.var.actor, (tx) =>
          tx.query(
            `UPDATE notification_settings
                SET training_ending_notice_days = $1, late_evaluation_reminder_days = $2, pending_request_alert_days = $3
              WHERE id = 1`,
            [values.trainingEndingNoticeDays, values.lateEvaluationReminderDays, values.pendingRequestAlertDays],
          ),
        );
      }

      return json(values);
    },
  },
];

async function loadIntervals(c: Context<AppEnv>): Promise<NotificationIntervals> {
  const { rows } = await c.var.db.query<{
    training_ending_notice_days: number;
    late_evaluation_reminder_days: number;
    pending_request_alert_days: number;
  }>(
    `SELECT training_ending_notice_days, late_evaluation_reminder_days, pending_request_alert_days
       FROM notification_settings WHERE id = 1`,
  );
  const row = rows[0];
  if (!row)
    throw new Error('The notification_settings row (id = 1) is missing; it is seeded by the AdminModule migration.');
  return {
    trainingEndingNoticeDays: row.training_ending_notice_days,
    lateEvaluationReminderDays: row.late_evaluation_reminder_days,
    pendingRequestAlertDays: row.pending_request_alert_days,
  };
}

function toUser(row: Omit<EmployeeRow, 'version'>) {
  return { id: row.id, fullName: row.full_name, email: row.email, department: row.department, role: row.role };
}

async function single<T extends object>(db: Queryable, sql: string, id: string, typeName: string): Promise<T> {
  const { rows } = await db.query<T & Record<string, unknown>>(sql, [id]);
  if (!rows[0]) throw NotFoundError.for(typeName, id);
  return rows[0];
}
