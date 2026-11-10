import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError } from '../../domain/errors';
import { parseGuid } from '../../domain/uuid';
import { json } from '../../http/problems';
import type { Route } from '../../http/routes';
import { AUDIT_FACTS_SQL, AUDITED_TABLES, describeAudit } from './auditDescriptions';

/**
 * `GET /api/admin/audit-logs` (Admin role only; owner decision AD-51): the audit log, read-only, newest first, in pages.
 * Only safe metadata is returned, chosen column by column: never `old_values` / `new_values` (they can hold sign-in code
 * and token hashes, file storage keys and personal data), and no record id for the sign-in tables, whose ids are those of
 * sessions and sign-in codes. Filters: operation, table, actor (type and/or id) and a time range.
 *
 * Who acted is also given by name: for a Staff actor the employee's name and their current role (roles are not kept
 * historically, so it may differ from their role when they acted); for a Trainee actor the trainee's name, which is
 * null until the trainee enters it. `actorKnown` says whether the account was found. Names come from the same query
 * (one join per account table), never from the stored values, and nothing else about the account (e-mail, phone) is read.
 *
 * Each entry also has a `description`: an event code and safe parameters, derived when the log is read from allowlisted
 * facts of the stored values (`auditDescriptions.ts`, owner requirements ADL-01 to ADL-06). The facts stay in the Worker;
 * only the code and enum parameters (roles, statuses, names of changed properties) are returned.
 */
export const AUDIT_PAGE_SIZE = 50;

/** Every table with the audit trigger (`ims_protect_table`); the table filter accepts only these. */
export { AUDITED_TABLES };

/** Tables whose record ids are session or sign-in code ids: shown without them. */
export const HIDDEN_ENTITY_TABLES = ['user_sessions', 'trainee_sign_in_codes'] as const;

const OPERATIONS = ['INSERT', 'UPDATE'] as const;
const ACTOR_TYPES = ['Anonymous', 'Staff', 'Trainee', 'System', 'Database'] as const;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  actor_known: boolean;
  actor_name: string | null;
  actor_current_role: string | null;
  facts: unknown;
  operation: string;
  table_name: string;
  entity_id: string | null;
}

/** A query value from a fixed list; absent or empty is "any". Fixed error messages: nothing from the request is echoed. */
function oneOf<T extends string>(c: Context<AppEnv>, name: string, values: readonly T[]): T | null {
  const value = c.req.query(name);
  if (!value) return null;
  if (!(values as readonly string[]).includes(value)) {
    throw new DomainError('validation.invalid', `The ${name} filter is not valid.`);
  }
  return value as T;
}

function instant(c: Context<AppEnv>, name: string): string | null {
  const value = c.req.query(name);
  if (!value) return null;
  const time = INSTANT.test(value) ? new Date(value) : null;
  if (!time || Number.isNaN(time.getTime())) {
    throw new DomainError('validation.invalid', `The ${name} time must be an ISO 8601 date and time with a zone.`);
  }
  return time.toISOString();
}

function filters(c: Context<AppEnv>) {
  const before = c.req.query('before');
  if (before && !/^[1-9]\d{0,17}$/.test(before)) {
    throw new DomainError('validation.invalid', 'The before cursor is not valid.');
  }
  const actor = c.req.query('actorId');
  const actorId = actor ? parseGuid(actor) : null;
  if (actor && !actorId) throw new DomainError('validation.invalid', 'The actorId filter is not valid.');
  const from = instant(c, 'from');
  const to = instant(c, 'to');
  if (from && to && to <= from)
    throw new DomainError('validation.period', 'The end of the range must be after its start.');
  return {
    before: before || null,
    operation: oneOf(c, 'operation', OPERATIONS),
    table: oneOf(c, 'table', AUDITED_TABLES),
    actorType: oneOf(c, 'actorType', ACTOR_TYPES),
    actorId,
    from,
    to,
  };
}

export const auditLogRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/admin/audit-logs',
    policy: 'Admin',
    async handle(c) {
      const f = filters(c);
      const { rows } = await c.var.db.query<AuditRow>(
        `SELECT a.id::text, a.occurred_at, a.actor_type, a.actor_id, a.operation, a.table_name,
                CASE WHEN a.table_name = ANY($9::text[]) THEN NULL ELSE a.entity_id END AS entity_id,
                (e.id IS NOT NULL OR t.id IS NOT NULL) AS actor_known,
                coalesce(e.full_name, t.full_name) AS actor_name,
                e.role AS actor_current_role,
                ${AUDIT_FACTS_SQL} AS facts
           FROM audit_logs a
           LEFT JOIN employees e ON a.actor_type = 'Staff' AND e.id = a.actor_id
           LEFT JOIN trainees t ON a.actor_type = 'Trainee' AND t.id = a.actor_id
          WHERE ($1::bigint IS NULL OR a.id < $1::bigint)
            AND ($2::text IS NULL OR a.operation = $2)
            AND ($3::text IS NULL OR a.table_name = $3)
            AND ($4::text IS NULL OR a.actor_type = $4)
            AND ($5::uuid IS NULL OR a.actor_id = $5)
            AND ($6::timestamptz IS NULL OR a.occurred_at >= $6)
            AND ($7::timestamptz IS NULL OR a.occurred_at < $7)
          ORDER BY a.id DESC
          LIMIT $8`,
        [
          f.before,
          f.operation,
          f.table,
          f.actorType,
          f.actorId,
          f.from,
          f.to,
          AUDIT_PAGE_SIZE + 1,
          HIDDEN_ENTITY_TABLES,
        ],
      );
      const page = rows.slice(0, AUDIT_PAGE_SIZE);
      return json({
        hasMore: rows.length > AUDIT_PAGE_SIZE,
        entries: page.map((r) => ({
          id: r.id,
          occurredAt: r.occurred_at,
          actorType: r.actor_type,
          actorId: r.actor_id,
          actorKnown: r.actor_known,
          actorName: r.actor_name,
          actorCurrentRole: r.actor_current_role,
          operation: r.operation,
          table: r.table_name,
          entityId: r.entity_id,
          description: describeAudit(r.table_name, r.operation, r.facts),
        })),
      });
    },
  },
];
