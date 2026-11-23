import { describe, expect, it } from 'vitest';
import { createTestApi, signInStaff, signInTrainee, withDb } from './helpers';
import { createIsolatedDatabase } from './isolated-database';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * The isolated test database helper (AD-71, alternative B) and the optional database argument of the shared helpers:
 * without it they keep using the shared test database exactly as before; with it, everything (requests, sign-ins, role
 * changes, seeding) goes to the isolated database and nothing falls back to the shared one.
 */
const PARITY_SQL = `
  SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')::int AS tables,
         (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)::int AS triggers,
         (SELECT count(*) FROM pg_constraint)::int AS constraints,
         (SELECT count(*) FROM "__EFMigrationsHistory")::int AS migrations,
         (SELECT md5(string_agg(c.relname || '.' || a.attname || ':' ||
                   has_column_privilege('ims_app', c.oid, a.attname, 'SELECT') || has_column_privilege('ims_app', c.oid, a.attname, 'INSERT') ||
                   has_column_privilege('ims_app', c.oid, a.attname, 'UPDATE'), ',' ORDER BY c.relname, a.attname))
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped) AS app_columns,
         (SELECT md5(string_agg(tablename || ':' || has_table_privilege('ims_app', 'public.' || quote_ident(tablename), 'DELETE') ||
                   has_table_privilege('ims_app', 'public.' || quote_ident(tablename), 'TRUNCATE'), ',' ORDER BY tablename))
            FROM pg_tables WHERE schemaname = 'public') AS app_tables`;

describe('isolated test database', () => {
  it('has the shared database’s schema, triggers, constraints and ims_app grants; the Worker connects as ims_app', async () => {
    const isolated = await createIsolatedDatabase();
    expect(isolated.name).toMatch(/^ims_isolated_[0-9a-f]{16}$/);
    const [shared, own] = await Promise.all([
      withDb((db) => db.query(PARITY_SQL)),
      withDb((db) => db.query(PARITY_SQL), isolated.ownerUrl),
    ]);
    expect(own.rows[0]).toEqual(shared.rows[0]);
    expect(own.rows[0].triggers).toBeGreaterThan(0);

    const pg = await import('pg');
    const app = new pg.default.Client({ connectionString: isolated.appUrl });
    app.on('error', () => undefined);
    await app.connect();
    try {
      expect((await app.query('SELECT current_user AS u, current_database() AS d')).rows[0]).toEqual({
        u: 'ims_app',
        d: isolated.name,
      });
      expect(
        await app.query('DELETE FROM fields').then(
          () => 'allowed',
          (e: { code: string }) => e.code,
        ),
      ).toBe('42501');
    } finally {
      await app.end().catch(() => undefined);
    }
  });

  it('routes requests, sign-ins, role changes and seeding to the isolated database, never to the shared one', async () => {
    const isolated = await createIsolatedDatabase();
    const api = isolated.api();
    expect(api.ownerDatabaseUrl).toBe(isolated.ownerUrl);
    const admin = await signInStaff(api, 'Admin');
    const mentor = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const field = await newField(admin.client); // an Admin request: the role was set in the isolated database
    const applicationId = await submitApplication(trainee.client, field.id);
    const assignment = await seedAssignment(
      applicationId,
      mentor.user.id,
      '2031-01-01',
      '2031-02-01',
      'Active',
      isolated.ownerUrl,
    );

    const where = (url?: string) =>
      withDb(
        async (db) =>
          (
            await db.query<{ role: string | null; field: number; assignment: number }>(
              `SELECT (SELECT role FROM employees WHERE id = $1) AS role,
                      (SELECT count(*)::int FROM fields WHERE id = $2) AS field,
                      (SELECT count(*)::int FROM assignments WHERE id = $3) AS assignment`,
              [admin.user.id, field.id, assignment],
            )
          ).rows[0],
        url,
      );
    expect(await where(isolated.ownerUrl)).toEqual({ role: 'Admin', field: 1, assignment: 1 });
    expect(await where()).toEqual({ role: null, field: 0, assignment: 0 });
  });

  it('leaves the defaults unchanged: without an argument everything uses the shared test database', async () => {
    const isolated = await createIsolatedDatabase();
    expect(await withDb(async (db) => (await db.query('SELECT current_database() AS d')).rows[0].d)).toBe('ims_test');
    const api = createTestApi();
    const admin = await signInStaff(api, 'HR');
    const mentor = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const field = await newField((await signInStaff(api, 'Admin')).client);
    const applicationId = await submitApplication(trainee.client, field.id);
    const assignment = await seedAssignment(applicationId, mentor.user.id, '2031-01-01', '2031-02-01', 'Active');
    const count = (url?: string) =>
      withDb(
        async (db) =>
          (
            await db.query<{ role: string | null; assignment: number }>(
              `SELECT (SELECT role FROM employees WHERE id = $1) AS role,
                      (SELECT count(*)::int FROM assignments WHERE id = $2) AS assignment`,
              [admin.user.id, assignment],
            )
          ).rows[0],
        url,
      );
    expect(await count()).toEqual({ role: 'HR', assignment: 1 });
    expect(await count(isolated.ownerUrl)).toEqual({ role: null, assignment: 0 });
  });

  it.each([
    [
      'an external database (TEST_DATABASE_URL: one URL for both)',
      (s: Shared) => ({ ...s, DATABASE_URL: s.OWNER_DATABASE_URL }),
    ],
    [
      'the Worker running as the owner (TEST_DATABASE_ROLE=owner)',
      (s: Shared) => ({ ...s, DATABASE_URL: s.OWNER_DATABASE_URL.replace(/\/\/[^:]+:/, '//other:') }),
    ],
    [
      'a host other than loopback',
      (s: Shared) => ({
        ...s,
        DATABASE_URL: s.DATABASE_URL.replace(/@[^/]+\//, '@db.example.com:5432/'),
        OWNER_DATABASE_URL: s.OWNER_DATABASE_URL.replace(/@[^/]+\//, '@db.example.com:5432/'),
      }),
    ],
    [
      'a database other than ims_test',
      (s: Shared) => ({
        ...s,
        DATABASE_URL: s.DATABASE_URL.replace(/\/ims_test/, '/ims_dev'),
        OWNER_DATABASE_URL: s.OWNER_DATABASE_URL.replace(/\/ims_test/, '/ims_dev'),
      }),
    ],
    ['a Hyperdrive binding', (s: Shared) => ({ ...s, HYPERDRIVE: {} })],
    ['missing URLs', () => ({})],
  ])('refuses, creating nothing, with %s', async (_case, change) => {
    const { env } = await import('cloudflare:workers');
    const shared = env as unknown as Shared;
    await expect(createIsolatedDatabase(change(shared))).rejects.toThrow(/Nothing was created/);
  });
});

interface Shared {
  DATABASE_URL: string;
  OWNER_DATABASE_URL: string;
  HYPERDRIVE?: unknown;
}
