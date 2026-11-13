import { env } from 'cloudflare:workers';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/config';
import { body, createTestApi, signInStaff, unique, withDb } from './helpers';

/**
 * The Worker's least-privilege database role `ims_app` (scripts/ims-app-grants.sql; Option A of the assessment of
 * 2026-11-03, locally tested only). Runs in the disposable test container: every forbidden attempt is refused before
 * it changes anything, and the one successful forgery (the control case) is rolled back.
 */
const api = createTestApi();

const appUrl = () => (env as unknown as Bindings).DATABASE_URL!;

/** Runs `work` on a fresh connection with the given URL (by default the Worker's, i.e. `ims_app`). */
async function connect<T>(work: (db: pg.Client) => Promise<T>, url = appUrl()): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The PostgreSQL error of `sql` run as `ims_app` (each attempt on its own connection, in a transaction rolled back). */
async function refused(sql: string): Promise<{ code: string; message: string }> {
  return connect(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query(sql);
    } catch (error) {
      return error as { code: string; message: string };
    } finally {
      await db.query('ROLLBACK').catch(() => undefined);
    }
    throw new Error(`Expected to be refused: ${sql}`);
  });
}

const TABLES = [
  'application_attachments',
  'assignment_extensions',
  'assignment_transfers',
  'assignments',
  'audit_logs',
  'certificate_templates',
  'contact_logs',
  'employees',
  'evaluation_criteria',
  'fields',
  'mentor_requests',
  'notification_settings',
  'notifications',
  'progress_notes',
  'responsible_hr_changes',
  'roles',
  'trainee_sign_in_codes',
  'trainees',
  'training_applications',
  'transfer_decisions',
  'user_sessions',
  '__EFMigrationsHistory',
];
const SELECT = TABLES.filter((t) => t !== 'roles' && t !== '__EFMigrationsHistory');
const INSERT = SELECT.filter((t) => t !== 'notification_settings');
const UPDATE = [
  'certificate_templates',
  'employees',
  'evaluation_criteria',
  'fields',
  'mentor_requests',
  'notification_settings',
  'notifications',
  'trainee_sign_in_codes',
  'trainees',
  'training_applications',
  'user_sessions',
];

describe('ims_app: who the Worker is', () => {
  it('the Worker connects as ims_app, an ordinary login role that owns nothing and belongs to no role', async () => {
    const me = await connect((db) =>
      db.query<Record<string, unknown>>(
        `SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
                r.rolcanlogin, (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
                (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned_relations,
                (SELECT count(*)::int FROM pg_proc p WHERE p.proowner = r.oid) AS owned_functions,
                (SELECT count(*)::int FROM pg_namespace n WHERE n.nspowner = r.oid) AS owned_schemas
           FROM pg_roles r WHERE r.rolname = current_user`,
      ),
    );
    expect(me.rows[0]).toEqual({
      name: 'ims_app',
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      rolreplication: false,
      rolcanlogin: true,
      memberships: 0,
      owned_relations: 0,
      owned_functions: 0,
      owned_schemas: 0,
    });
  });

  it('writes through the API are audited with the right actor, by database user ims_app', async () => {
    const admin = await signInStaff(api, 'Admin');
    const field = await body<{ id: string }>(await admin.client.post('/api/admin/fields', { name: unique('Field') }));
    const rows = await withDb((db) =>
      db.query('SELECT operation, actor_type, actor_id, database_user FROM audit_logs WHERE entity_id = $1', [
        field.id,
      ]),
    );
    expect(rows.rows).toEqual([
      { operation: 'INSERT', actor_type: 'Staff', actor_id: admin.user.id, database_user: 'ims_app' },
    ]);
    // Every audit trigger is still enabled.
    const disabled = await withDb((db) =>
      db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O'"),
    );
    expect(disabled.rows[0]).toEqual({ n: 0 });
  });
});

describe('ims_app: exactly the privileges the Worker needs', () => {
  it('has SELECT, INSERT and UPDATE exactly as granted, and never DELETE, TRUNCATE, TRIGGER or REFERENCES', async () => {
    const privileges = await withDb((db) =>
      db.query<{ table: string; privilege: string; granted: boolean }>(
        `SELECT t AS table, p AS privilege, has_table_privilege('ims_app', format('public.%I', t), p) AS granted
           FROM unnest($1::text[]) AS t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES']) AS p`,
        [TABLES],
      ),
    );
    const granted = (privilege: string) =>
      privileges.rows
        .filter((r) => r.privilege === privilege && r.granted)
        .map((r) => r.table)
        .sort();
    expect(granted('SELECT')).toEqual([...SELECT].sort());
    expect(granted('INSERT')).toEqual([...INSERT].sort());
    expect(granted('UPDATE')).toEqual([...UPDATE].sort());
    for (const privilege of ['DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) expect(granted(privilege)).toEqual([]);
  });

  it('may update only the status, end date and end reason of an assignment (AD-63 Phase 1), nothing else', async () => {
    const columns = await withDb((db) =>
      db.query<{ column: string; granted: boolean }>(
        `SELECT a.attname AS column, has_column_privilege('ims_app', 'public.assignments', a.attname, 'UPDATE') AS granted
           FROM pg_attribute a WHERE a.attrelid = 'public.assignments'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attname`,
      ),
    );
    expect(columns.rows.filter((c) => c.granted).map((c) => c.column)).toEqual(['end_date', 'end_reason', 'status']);
    expect(columns.rows.filter((c) => !c.granted).map((c) => c.column)).toEqual([
      'application_id',
      'created_at',
      'employee_id',
      'id',
      'mentor_request_id',
      'start_date',
    ]);
  });

  it('may update only the resolution of a transfer decision (AD-65), never what was decided', async () => {
    const columns = await withDb((db) =>
      db.query<{ column: string; granted: boolean }>(
        `SELECT a.attname AS column,
                has_column_privilege('ims_app', 'public.transfer_decisions', a.attname, 'UPDATE') AS granted
           FROM pg_attribute a
          WHERE a.attrelid = 'public.transfer_decisions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attname`,
      ),
    );
    expect(columns.rows.filter((c) => c.granted).map((c) => c.column)).toEqual([
      'resolution_code',
      'resolution_reason',
      'resolved_at',
      'resolved_by_id',
      'status',
    ]);
    expect(columns.rows.filter((c) => !c.granted).map((c) => c.column)).toEqual([
      'application_id',
      'decided_at',
      'decided_by_id',
      'effective_date',
      'from_assignment_id',
      'id',
      'incoming_employee_id',
      'reason',
    ]);
  });

  it('cannot create anything: no schema CREATE, no TEMP (also not through PUBLIC), no protect function', async () => {
    const checks = await withDb((db) =>
      db.query(
        `SELECT has_schema_privilege('ims_app', 'public', 'CREATE') AS schema_create,
                has_database_privilege('ims_app', current_database(), 'TEMP') AS app_temp,
                has_database_privilege('public', current_database(), 'TEMP') AS public_temp,
                has_database_privilege('ims_app', current_database(), 'CREATE') AS database_create,
                has_function_privilege('ims_app', 'ims_protect_table(regclass)', 'EXECUTE') AS protect_table,
                has_parameter_privilege('ims_app', 'session_replication_role', 'SET') AS replication_role`,
      ),
    );
    expect(checks.rows[0]).toEqual({
      schema_create: false,
      app_temp: false,
      public_temp: false,
      database_create: false,
      protect_table: false,
      replication_role: false,
    });
  });
});

describe('ims_app: refused (negative tests, disposable test database only)', () => {
  const tamper = '01a10000-0000-7000-8000-000000000000';
  it.each([
    ['UPDATE audit_logs', "UPDATE audit_logs SET actor_type = 'System' WHERE id = 1"],
    ["UPDATE an assignment's employee", 'UPDATE assignments SET employee_id = employee_id'],
    ["UPDATE an assignment's start date", 'UPDATE assignments SET start_date = start_date'],
    ["UPDATE a transfer decision's date", 'UPDATE transfer_decisions SET effective_date = effective_date'],
    [
      "UPDATE a transfer decision's mentor",
      'UPDATE transfer_decisions SET incoming_employee_id = incoming_employee_id',
    ],
    ['UPDATE an executed transfer link', 'UPDATE assignment_transfers SET to_assignment_id = to_assignment_id'],
    ['DELETE a transfer decision', 'DELETE FROM transfer_decisions'],
    ['DELETE FROM audit_logs', 'DELETE FROM audit_logs WHERE id = 1'],
    ['TRUNCATE audit_logs', 'TRUNCATE audit_logs'],
    ['DISABLE an audit trigger', 'ALTER TABLE fields DISABLE TRIGGER audit_row_change'],
    ['DISABLE the append-only trigger', 'ALTER TABLE audit_logs DISABLE TRIGGER append_only'],
    ['DISABLE all triggers', 'ALTER TABLE audit_logs DISABLE TRIGGER ALL'],
    ['DROP an audit trigger', 'DROP TRIGGER audit_row_change ON fields'],
    [
      'replace the audit function',
      "CREATE OR REPLACE FUNCTION ims_audit_row_change() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'",
    ],
    ['drop the no-delete function', 'DROP FUNCTION ims_prevent_delete() CASCADE'],
    ['run the protect function', "SELECT ims_protect_table('fields')"],
    ['CREATE TABLE', 'CREATE TABLE public.ims_app_table (id int)'],
    ['DROP a protected table', 'DROP TABLE fields'],
    ['ALTER a protected table', 'ALTER TABLE audit_logs ADD COLUMN note text'],
    ['CREATE TEMP TABLE', 'CREATE TEMP TABLE ims_app_temp (id int)'],
    ['CREATE a temporary function', "CREATE FUNCTION pg_temp.ims_app_f() RETURNS int LANGUAGE sql AS 'SELECT 1'"],
    ['bypass triggers with session_replication_role', 'SET session_replication_role = replica'],
    ['DELETE a business record', `DELETE FROM fields WHERE id = '${tamper}'`],
    ['TRUNCATE a business table', 'TRUNCATE fields'],
    ['DELETE a session', `DELETE FROM user_sessions WHERE id = '${tamper}'`],
    ['create a role', 'CREATE ROLE ims_app_escalated LOGIN SUPERUSER'],
    ['create an ordinary role', 'CREATE ROLE ims_app_other'],
    ['become the owner', 'SET ROLE ims'],
  ])('%s', async (_name, sql) => {
    const error = await refused(sql);
    expect(error.code, error.message).toBe('42501'); // insufficient_privilege
  });

  it('cannot grant itself more: GRANT without a grant option changes nothing (PostgreSQL only warns)', async () => {
    const notices: string[] = [];
    await connect(async (db) => {
      db.on('notice', (notice) => notices.push(notice.message ?? ''));
      await db.query('GRANT DELETE, TRUNCATE ON fields, audit_logs TO ims_app');
    });
    expect(notices.some((m) => /no privileges were granted/.test(m))).toBe(true);
    const after = await withDb((db) =>
      db.query(
        `SELECT has_table_privilege('ims_app', 'fields', 'DELETE') AS fields_delete,
                has_table_privilege('ims_app', 'audit_logs', 'DELETE') AS audit_delete,
                has_table_privilege('ims_app', 'audit_logs', 'TRUNCATE') AS audit_truncate`,
      ),
    );
    expect(after.rows[0]).toEqual({ fields_delete: false, audit_delete: false, audit_truncate: false });
  });

  it('a direct INSERT of a forged audit entry is refused by the append-only trigger', async () => {
    const error = await refused(
      `INSERT INTO audit_logs (occurred_at, actor_type, actor_id, database_user, transaction_id, operation, table_name,
                               entity_id, new_values)
       VALUES (now(), 'Staff', '${tamper}', 'ims_app', 0, 'INSERT', 'fields', 'forged', '{}')`,
    );
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/append-only/);
  });

  it('the temporary-table trigger path to a forged audit entry is closed (and is real without the TEMP revoke)', async () => {
    const forge = `
      CREATE TEMP TABLE ims_forge (id int);
      CREATE FUNCTION pg_temp.ims_forge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO audit_logs (occurred_at, actor_type, actor_id, database_user, transaction_id, operation, table_name,
                                entity_id, new_values)
        VALUES (now(), 'Staff', '${tamper}', 'ims_app', 0, 'INSERT', 'fields', 'forged-by-temp-trigger', '{}');
        RETURN NULL;
      END $$;
      CREATE TRIGGER ims_forge AFTER INSERT ON ims_forge FOR EACH ROW EXECUTE FUNCTION pg_temp.ims_forge();
      INSERT INTO ims_forge VALUES (1);`;

    // As ims_app: refused at the first step (no temporary objects).
    const error = await refused(forge);
    expect(error.code).toBe('42501');
    expect(error.message).toMatch(/temporary/);

    // Control: the same rights plus TEMP (what Option A would leave without the revoke) do forge an entry. A throwaway
    // role in this disposable database; the forged row is rolled back.
    const password = crypto.randomUUID().replace(/-/g, '');
    const role = `ims_app_with_temp_${password.slice(0, 8)}`;
    await withDb(async (db) => {
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE ims_app`);
      await db.query(
        `GRANT TEMPORARY ON DATABASE ${(await db.query('SELECT current_database() AS d')).rows[0].d} TO ${role}`,
      );
    });
    const url = new URL(appUrl());
    url.username = role;
    url.password = password;
    const forged = await connect(async (db) => {
      await db.query('BEGIN');
      try {
        await db.query(forge);
        const { rows } = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = 'forged-by-temp-trigger'",
        );
        return rows[0]!.n;
      } finally {
        await db.query('ROLLBACK');
      }
    }, url.toString());
    expect(forged).toBe(1); // the loophole is real, so the TEMP revoke is what closes it
    const kept = await withDb((db) =>
      db.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = 'forged-by-temp-trigger'"),
    );
    expect(kept.rows[0]).toEqual({ n: 0 }); // nothing stayed
  });
});
