import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withDb } from './helpers';

/**
 * Audit and no-delete protection, read from the database catalog (PDF §8: every change audited, nothing deleted). Every
 * table in the schema is checked, so a table added by a later migration without `ims_protect_table` fails here.
 */
const BUSINESS_TABLES = [
  'application_attachments',
  'assignments',
  'certificate_templates',
  'contact_logs',
  'employees',
  'evaluation_criteria',
  'fields',
  'mentor_requests',
  'notification_settings',
  'notifications',
  'progress_notes',
  'roles',
  'trainee_sign_in_codes',
  'trainees',
  'training_applications',
  'user_sessions',
];

interface TriggerRow {
  table: string;
  name: string;
  enabled: string;
  fn: string;
  tgtype: number;
}

/** pg_trigger.tgtype bits (PostgreSQL `trigger.h`). */
function describeTrigger(t: TriggerRow) {
  const events = [
    t.tgtype & 4 ? 'INSERT' : null,
    t.tgtype & 8 ? 'DELETE' : null,
    t.tgtype & 16 ? 'UPDATE' : null,
    t.tgtype & 32 ? 'TRUNCATE' : null,
  ].filter(Boolean);
  return {
    name: t.name,
    enabled: t.enabled === 'O',
    timing: t.tgtype & 2 ? 'BEFORE' : t.tgtype & 64 ? 'INSTEAD OF' : 'AFTER',
    level: t.tgtype & 1 ? 'ROW' : 'STATEMENT',
    events,
    fn: t.fn,
  };
}

const AUDIT = {
  name: 'audit_row_change',
  enabled: true,
  timing: 'AFTER',
  level: 'ROW',
  events: ['INSERT', 'UPDATE'],
  fn: 'ims_audit_row_change',
};
const NO_DELETE = {
  name: 'no_delete',
  enabled: true,
  timing: 'BEFORE',
  level: 'ROW',
  events: ['DELETE'],
  fn: 'ims_prevent_delete',
};
const NO_TRUNCATE = {
  name: 'no_truncate',
  enabled: true,
  timing: 'BEFORE',
  level: 'STATEMENT',
  events: ['TRUNCATE'],
  fn: 'ims_prevent_delete',
};

/** Every table of the schema and its triggers, read with `db` (so it can also run inside a transaction). */
async function readSchema(db: pg.Client) {
  {
    const tables = await db.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '__EFMigrationsHistory'
        ORDER BY 1`,
    );
    const triggers = await db.query<TriggerRow>(
      `SELECT c.relname AS table, t.tgname AS name, t.tgenabled AS enabled, p.proname AS fn, t.tgtype::int AS tgtype
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY 1, 2`,
    );
    const byTable = new Map<string, ReturnType<typeof describeTrigger>[]>();
    for (const row of triggers.rows) byTable.set(row.table, [...(byTable.get(row.table) ?? []), describeTrigger(row)]);
    return { tables: tables.rows.map((r) => r.table), byTable };
  }
}

const schema = () => withDb(readSchema);

describe('audit and no-delete protection (database catalog)', () => {
  it('every business table is audited and refuses DELETE and TRUNCATE, with enabled triggers', async () => {
    const { tables, byTable } = await schema();
    const business = tables.filter((t) => t !== 'audit_logs');
    // Every table found, including any added later, must carry the three protections.
    for (const table of business) {
      expect(byTable.get(table), table).toEqual([AUDIT, NO_DELETE, NO_TRUNCATE]);
    }
    // The known tables, so that a new one is a deliberate change here too.
    expect(business).toEqual(BUSINESS_TABLES);
  });

  it('audit_logs is append-only (written only by the audit trigger) and refuses TRUNCATE, and is not itself audited', async () => {
    const { tables, byTable } = await schema();
    expect(tables).toContain('audit_logs');
    expect(byTable.get('audit_logs')).toEqual([
      {
        name: 'append_only',
        enabled: true,
        timing: 'BEFORE',
        level: 'ROW',
        events: ['INSERT', 'DELETE', 'UPDATE'],
        fn: 'ims_audit_logs_append_only',
      },
      {
        name: 'no_truncate',
        enabled: true,
        timing: 'BEFORE',
        level: 'STATEMENT',
        events: ['TRUNCATE'],
        fn: 'ims_audit_logs_append_only',
      },
    ]);
  });

  it('detects a new table that was created without the protection (rolled back)', async () => {
    const found = await withDb(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query('CREATE TABLE ims_unprotected_probe (id uuid PRIMARY KEY)');
        const { tables, byTable } = await readSchema(db);
        return { listed: tables.includes('ims_unprotected_probe'), triggers: byTable.get('ims_unprotected_probe') };
      } finally {
        await db.query('ROLLBACK');
      }
    });
    // The first test would fail on it: listed among the tables, with none of the three triggers.
    expect(found).toEqual({ listed: true, triggers: undefined });
    const { tables } = await schema();
    expect(tables).not.toContain('ims_unprotected_probe'); // nothing stayed
  });

  it('no event trigger or row-level security can bypass them', async () => {
    const result = await withDb((db) =>
      db.query<{ event_triggers: number; rls_tables: number }>(
        `SELECT (SELECT count(*)::int FROM pg_event_trigger) AS event_triggers,
                (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relrowsecurity) AS rls_tables`,
      ),
    );
    expect(result.rows[0]).toEqual({ event_triggers: 0, rls_tables: 0 });
  });
});
