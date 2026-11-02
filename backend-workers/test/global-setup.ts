import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Runs in Node before the Workers tests: starts a disposable PostgreSQL 18.6 container (like the C# tests'
 * Testcontainers), creates the schema from test/schema.sql (generated from the EF Core migrations) and provides its
 * URL to the tests. The container keeps its data in memory and is removed afterwards. Requires Docker.
 * Set TEST_DATABASE_URL to use an existing, empty, disposable database instead.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const IMAGE = 'postgres:18.6-alpine';
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, 'schema.sql');
const MIGRATIONS = join(HERE, '../../backend/src/Ims.Infrastructure/Persistence/Migrations');

export default async function setup(project: TestProject) {
  assertSchemaIsCurrent();

  let databaseUrl = process.env.TEST_DATABASE_URL;
  let container: string | null = null;
  if (!databaseUrl) {
    const password = randomBytes(18).toString('hex');
    container = docker(
      'run',
      '-d',
      '--rm',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_USER=ims',
      '-e',
      'POSTGRES_DB=ims_test',
      '--tmpfs',
      '/var/lib/postgresql',
      '-p',
      '127.0.0.1::5432',
      IMAGE,
    );
    const port = docker('port', container, '5432/tcp').split('\n')[0]!.split(':').pop();
    databaseUrl = `postgres://ims:${password}@127.0.0.1:${port}/ims_test?sslmode=disable`;
  }

  await waitForDatabase(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(readFileSync(SCHEMA, 'utf8'));
  } finally {
    await client.end();
  }

  project.provide('databaseUrl', databaseUrl);

  return () => {
    if (container) docker('stop', container);
  };
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForDatabase(url: string) {
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

/** test/schema.sql must contain exactly the EF Core migrations in ../backend (run `npm run schema:generate`). */
function assertSchemaIsCurrent() {
  const sql = readFileSync(SCHEMA, 'utf8');
  const inSchema = [
    ...sql.matchAll(/INSERT INTO "__EFMigrationsHistory" \("MigrationId", "ProductVersion"\)\s+VALUES \('([^']+)'/g),
  ]
    .map((m) => m[1])
    .sort();
  const migrations = readdirSync(MIGRATIONS)
    .map((file) => /^(\d{14}_[A-Za-z0-9]+)\.cs$/.exec(file)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
  if (JSON.stringify(inSchema) !== JSON.stringify(migrations)) {
    throw new Error(
      `test/schema.sql is out of date (has ${inSchema.join(', ')}; migrations are ${migrations.join(', ')}). ` +
        'Run `npm run schema:generate`.',
    );
  }
}
