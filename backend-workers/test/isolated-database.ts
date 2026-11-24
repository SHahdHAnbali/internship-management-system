import { env } from 'cloudflare:workers';
import pg from 'pg';
import type { Dependencies } from '../src/context';
import type { Bindings } from '../src/config';
import grantsSql from '../scripts/ims-app-grants.sql?raw';
import { createTestApi, type TestApi } from './helpers';
import schemaSql from './schema.sql?raw';

/**
 * A database of its own for a test file, inside the disposable PostgreSQL container that test/global-setup.ts starts
 * (AD-71, owner decision of 2026-11-23, alternative B). For tests whose outcome depends on state every test file shares,
 * above all the set of active evaluation criteria (R27 S2.3: a submission needs a score for every active criterion and
 * refuses a changed set): no other test file writes to it, so its state is exactly what its own tests make it.
 *
 * It is built like the shared test database: test/schema.sql (the EF Core migrations, with their constraints, audit and
 * no-delete triggers and guards) and scripts/ims-app-grants.sql, unchanged; the Worker connects to it as `ims_app`. It is
 * never dropped: it disappears with the container. Fails closed: it creates nothing unless the shared test database is
 * provably that container's (an `ims_app` URL distinct from the owner's, on the loopback interface, as only the
 * container setup provides; a cluster holding no database but the test ones; a role allowed to create databases).
 * With TEST_DATABASE_URL (an external database) or TEST_DATABASE_ROLE=owner it refuses.
 */
export interface IsolatedDatabase {
  name: string;
  /** The schema owner on this database, for seeding and assertions (`withDb(work, ownerUrl)`). */
  ownerUrl: string;
  /** The Worker's least-privilege role on this database. */
  appUrl: string;
  /** A test API whose requests, sign-ins and role changes all use this database. */
  api(overrides?: Partial<Dependencies>, bindings?: Partial<Bindings>): TestApi;
}

const PREFIX = 'ims_isolated_';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const SHARED = 'ims_test';

interface SharedBindings {
  DATABASE_URL?: string;
  OWNER_DATABASE_URL?: string;
  HYPERDRIVE?: unknown;
}

/** `source`: the test bindings (the refusals are tested with others). */
export async function createIsolatedDatabase(
  source: SharedBindings = env as unknown as SharedBindings,
): Promise<IsolatedDatabase> {
  const bindings = source;
  const shared = { app: parse(bindings.DATABASE_URL), owner: parse(bindings.OWNER_DATABASE_URL) };
  const refuse = (why: string): never => {
    throw new Error(
      `Isolated test databases need the disposable container of test/global-setup.ts (TEST_DATABASE_URL and ` +
        `TEST_DATABASE_ROLE=owner are not supported): ${why}. Nothing was created.`,
    );
  };
  if (bindings.HYPERDRIVE !== undefined) refuse('a HYPERDRIVE binding is present');
  if (!shared.app || !shared.owner) refuse('the test database URLs are missing');
  const { app, owner } = shared as { app: URL; owner: URL };
  if (app.username !== 'ims_app' || app.username === owner.username) refuse('the Worker does not connect as ims_app');
  if (!LOOPBACK.has(app.hostname) || !LOOPBACK.has(owner.hostname) || app.host !== owner.host) {
    refuse('the test database is not on the loopback interface');
  }
  if (app.pathname !== `/${SHARED}` || owner.pathname !== `/${SHARED}`) refuse(`the test database is not ${SHARED}`);

  const name = `${PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await on(owner.toString(), async (db) => {
    const { rows: role } = await db.query<{ allowed: boolean }>(
      'SELECT rolsuper OR rolcreatedb AS allowed FROM pg_roles WHERE rolname = current_user',
    );
    if (!role[0]?.allowed) refuse('the owner role cannot create databases');
    const { rows: others } = await db.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname NOT IN ('postgres', 'template0', 'template1', $1) AND left(datname, length($2)) <> $2`,
      [SHARED, PREFIX],
    );
    if (others.length > 0) refuse('the PostgreSQL server holds other databases');
    await db.query(`CREATE DATABASE ${name}`); // a generated identifier: lower-case letters, digits, underscores
  });

  const ownerUrl = withDatabase(owner, name);
  const appUrl = withDatabase(app, name);
  await on(ownerUrl, async (db) => {
    await db.query(schemaSql);
    await db.query(grantsSql);
  });

  return {
    name,
    ownerUrl,
    appUrl,
    api: (overrides = {}, extra = {}) =>
      createTestApi(overrides, { ...extra, DATABASE_URL: appUrl }, { ownerDatabaseUrl: ownerUrl }),
  };
}

function parse(url: string | undefined): URL | null {
  try {
    return url ? new URL(url) : null;
  } catch {
    return null;
  }
}

function withDatabase(base: URL, name: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  return url.toString();
}

async function on(url: string, work: (db: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined); // pg-cloudflare reports its socket shutdown after end()
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
