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
  'evaluation_corrections',
  'evaluation_criteria',
  'evaluation_scores',
  'evaluations',
  'fields',
  'mentor_requests',
  'notification_settings',
  'notifications',
  'pending_reminders',
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
/**
 * R27 (owner, 2026-11-22): the final evaluation tables have no table-wide INSERT or UPDATE. S2.2 grants the draft's
 * columns only (checked column by column below); `evaluation_corrections` stays read-only.
 */
const EVALUATION_TABLES = ['evaluations', 'evaluation_scores', 'evaluation_corrections'];
const INSERT = SELECT.filter((t) => t !== 'notification_settings' && !EVALUATION_TABLES.includes(t));
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

  it('may update only the outcome of a pending-request reminder (NEW-05), never which request or when', async () => {
    const columns = await withDb((db) =>
      db.query<{ column: string; granted: boolean }>(
        `SELECT a.attname AS column,
                has_column_privilege('ims_app', 'public.pending_reminders', a.attname, 'UPDATE') AS granted
           FROM pg_attribute a
          WHERE a.attrelid = 'public.pending_reminders'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attname`,
      ),
    );
    expect(columns.rows.filter((c) => c.granted).map((c) => c.column)).toEqual([
      'accepted_count',
      'completed_at',
      'failed_count',
      'outcome',
    ]);
    expect(columns.rows.filter((c) => !c.granted).map((c) => c.column)).toEqual([
      'application_id',
      'attempted_at',
      'id',
      'kind',
      'mentor_request_id',
      'recipient_count',
    ]);
  });

  it("may write only a final evaluation draft's columns (R27 S2.2), never its submission, snapshot or corrections", async () => {
    const columns = await withDb((db) =>
      db.query<{ table: string; column: string; insert: boolean; update: boolean }>(
        `SELECT c.relname AS table, a.attname AS column,
                has_column_privilege('ims_app', c.oid, a.attname, 'INSERT') AS insert,
                has_column_privilege('ims_app', c.oid, a.attname, 'UPDATE') AS update
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname IN ('evaluations', 'evaluation_scores', 'evaluation_corrections')
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY c.relname, a.attname`,
      ),
    );
    const granted = (table: string, privilege: 'insert' | 'update') =>
      columns.rows.filter((c) => c.table === table && c[privilege]).map((c) => c.column);
    expect(granted('evaluations', 'insert')).toEqual([
      'application_id',
      'assignment_id',
      'created_at',
      'id',
      'status',
      'updated_at',
    ]);
    expect(granted('evaluations', 'update')).toEqual(['comment', 'hiring_recommendation', 'updated_at', 'version']);
    expect(granted('evaluation_scores', 'insert')).toEqual(['criterion_id', 'evaluation_id', 'id', 'score']);
    expect(granted('evaluation_scores', 'update')).toEqual(['score']);
    expect(granted('evaluation_corrections', 'insert')).toEqual([]);
    expect(granted('evaluation_corrections', 'update')).toEqual([]);
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
    ["UPDATE a reminder's request", 'UPDATE pending_reminders SET application_id = application_id'],
    ["UPDATE a reminder's attempt time", 'UPDATE pending_reminders SET attempted_at = attempted_at'],
    ['DELETE a pending-request reminder', 'DELETE FROM pending_reminders'],
    ['TRUNCATE pending-request reminders', 'TRUNCATE pending_reminders'],
    // R27 S2.2 (owner, 2026-11-22): only a draft's columns are writable; never submission, snapshot or corrections.
    ...['submitted_by_id', 'submitted_at', 'comment', 'hiring_recommendation', 'version'].map((column) => [
      `INSERT an evaluation with ${column}`,
      `INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at, ${column}) VALUES ('${tamper}', '${tamper}', '${tamper}', 'Draft', now(), now(), NULL)`,
    ]),
    ...['status', 'submitted_by_id', 'submitted_at', 'application_id', 'assignment_id', 'created_at', 'id'].map(
      (column) => [`UPDATE an evaluation's ${column}`, `UPDATE evaluations SET ${column} = ${column}`],
    ),
    ['DELETE an evaluation', 'DELETE FROM evaluations'],
    ['TRUNCATE evaluations', 'TRUNCATE evaluations'],
    ...['frozen_name_ar', 'frozen_name_en', 'frozen_sort_order'].map((column) => [
      `INSERT an evaluation score with ${column}`,
      `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score, ${column}) VALUES ('${tamper}', '${tamper}', '${tamper}', 5, NULL)`,
    ]),
    ...['frozen_name_ar', 'frozen_name_en', 'frozen_sort_order', 'evaluation_id', 'criterion_id', 'id'].map(
      (column) => [`UPDATE an evaluation score's ${column}`, `UPDATE evaluation_scores SET ${column} = ${column}`],
    ),
    ['DELETE an evaluation score', 'DELETE FROM evaluation_scores'],
    ['TRUNCATE evaluation scores', 'TRUNCATE evaluation_scores'],
    [
      'INSERT an evaluation correction',
      `INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at) VALUES ('${tamper}', '${tamper}', '${tamper}', now())`,
    ],
    ['UPDATE an evaluation correction', "UPDATE evaluation_corrections SET reason = 'x'"],
    ['DELETE an evaluation correction', 'DELETE FROM evaluation_corrections'],
    ['TRUNCATE evaluation corrections', 'TRUNCATE evaluation_corrections'],
    ['DISABLE an evaluation guard', 'ALTER TABLE evaluations DISABLE TRIGGER evaluations_guard'],
    ['DROP a score guard', 'DROP TRIGGER evaluation_scores_guard ON evaluation_scores'],
    [
      'replace an evaluation guard function',
      "CREATE OR REPLACE FUNCTION ims_evaluations_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
    ],
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

describe('ims_app and the final evaluation guards (R27 S2.2; K1 option B, owner 2026-11-22)', () => {
  /** A training (seeded by the owner, actor System) and a criterion; returns their ids. */
  async function training() {
    const [employee, trainee, field, application, assignment, criterion] = [1, 2, 3, 4, 5, 6].map(() =>
      crypto.randomUUID(),
    ) as [string, string, string, string, string, string];
    await withDb((db) =>
      db.query(`
        INSERT INTO employees (id, full_name, email, role) VALUES ('${employee}', 'Guard Mentor', '${employee}@company.example', 'Employee');
        INSERT INTO trainees (id, email) VALUES ('${trainee}', '${trainee}@example.com');
        INSERT INTO fields (id, name, is_active) VALUES ('${field}', 'Guard ${field}', true);
        INSERT INTO training_applications (id, trainee_id, field_id, status, available_from, available_to, hours,
                                           mandatory_for_university, submitted_at, decided_at, decided_by_id)
          VALUES ('${application}', '${trainee}', '${field}', 'Accepted', '2026-01-01', '2026-03-01', 1, false, now(), now(), '${employee}');
        INSERT INTO assignments (id, application_id, employee_id, start_date, end_date, status, created_at)
          VALUES ('${assignment}', '${application}', '${employee}', '2026-01-01', '2026-03-01', 'Completed', now());
        INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active) VALUES ('${criterion}', 'معيار', 'Guard ${criterion}', true);
      `),
    );
    return { employee, application, assignment, criterion };
  }

  /** The PostgreSQL error (SQLSTATE and constraint) of `sql` run as ims_app, rolled back. */
  const refusal = async (sql: string) => {
    const error = (await refused(sql)) as { code: string; constraint?: string };
    return [error.code, error.constraint ?? null];
  };

  it('writes a draft with only its granted columns, as the draft API does (locks included)', async () => {
    const t = await training();
    const evaluation = crypto.randomUUID();
    await connect(async (db) => {
      await db.query('BEGIN');
      await db.query(
        `INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'Draft', now(), now()) ON CONFLICT (application_id) DO NOTHING`,
        [evaluation, t.application, t.assignment],
      );
      await db.query('SELECT version FROM evaluations WHERE id = $1 FOR UPDATE', [evaluation]);
      await db.query(
        `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), $1, $2, 3)
         ON CONFLICT (evaluation_id, criterion_id) DO UPDATE SET score = EXCLUDED.score`,
        [evaluation, t.criterion],
      );
      await db.query('UPDATE evaluation_scores SET score = 5 WHERE evaluation_id = $1', [evaluation]);
      await db.query(
        `UPDATE evaluations SET comment = 'Draft', hiring_recommendation = 'Maybe', version = version + 1, updated_at = now()
          WHERE id = $1`,
        [evaluation],
      );
      await db.query('COMMIT');
    });
    const stored = await withDb((db) =>
      db.query(
        'SELECT e.status, e.version, e.comment, s.score FROM evaluations e JOIN evaluation_scores s ON s.evaluation_id = e.id WHERE e.id = $1',
        [evaluation],
      ),
    );
    expect(stored.rows).toEqual([{ status: 'Draft', version: 1, comment: 'Draft', score: 5 }]);
  });

  it('cannot create a submitted evaluation: the columns it would need are not granted, the constraint refuses the rest', async () => {
    const t = await training();
    expect(
      await refusal(
        `INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at)
         VALUES (gen_random_uuid(), '${t.application}', '${t.assignment}', 'Submitted', now(), now())`,
      ),
    ).toEqual(['23514', 'ck_evaluations_submission']);
  });

  it('cannot clear a saved score, nor touch a submitted evaluation or its scores (database guards)', async () => {
    const t = await training();
    const evaluation = crypto.randomUUID();
    const other = (await training()).criterion;
    await withDb((db) =>
      db.query(`
        INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at)
          VALUES ('${evaluation}', '${t.application}', '${t.assignment}', 'Draft', now(), now());
        INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '${evaluation}', '${t.criterion}', 4);
      `),
    );
    expect(await refusal(`UPDATE evaluation_scores SET score = NULL WHERE evaluation_id = '${evaluation}'`)).toEqual([
      '23001',
      'evaluation_scores_not_cleared',
    ]);

    // Submitted the S2.3 way (by the owner here: the Worker has no grant for it yet).
    await withDb((db) =>
      db.query(`
        UPDATE evaluation_scores SET frozen_name_ar = 'معيار', frozen_name_en = 'Guard', frozen_sort_order = 1 WHERE evaluation_id = '${evaluation}';
        UPDATE evaluations SET status = 'Submitted', comment = 'Final', hiring_recommendation = 'Yes',
               submitted_by_id = '${t.employee}', submitted_at = now() WHERE id = '${evaluation}';
      `),
    );
    for (const sql of [
      `UPDATE evaluations SET comment = 'Changed' WHERE id = '${evaluation}'`,
      `UPDATE evaluations SET hiring_recommendation = 'No', version = version + 1, updated_at = now() WHERE id = '${evaluation}'`,
    ]) {
      expect(await refusal(sql), sql).toEqual(['23001', 'evaluations_submitted_readonly']);
    }
    for (const sql of [
      `UPDATE evaluation_scores SET score = 1 WHERE evaluation_id = '${evaluation}'`,
      `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '${evaluation}', '${other}', 2)`,
    ]) {
      expect(await refusal(sql), sql).toEqual(['23001', 'evaluation_scores_submitted_readonly']);
    }
  });
});
