import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import appGrants from '../scripts/ims-app-grants.sql?raw';
import { body, COMPANY_DOMAIN, createTestApi, ownerDatabaseUrl, TestClient, uniqueEmail } from './helpers';
import schema from './schema.sql?raw';

/**
 * Who may change an Admin's role (owner decisions 2026-11-07): AUD-01 a change never leaves zero Admins; AUD-02 an Admin
 * never changes their own role; AUD-03 an Admin may change another Admin's role while an Admin remains.
 *
 * "Zero Admins" can only be tested where the Admins are known, and the shared test database gets Admins from every test
 * file in parallel. So this file has its own database (same schema, same `ims_app` grants), and each test starts with
 * no Admin. The tests in a file run one after another.
 */
const api = createTestApi();
const NAME = `ims_governance_${crypto.randomUUID().replace(/-/g, '')}`;

const inDatabase = (url: string) => {
  const copy = new URL(url);
  copy.pathname = `/${NAME}`;
  return copy.toString();
};
const appUrl = () => inDatabase((env as unknown as { DATABASE_URL: string }).DATABASE_URL);

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined); // pg-cloudflare reports its socket shutdown after end()
  await client.connect();
  return client;
}

/** Runs SQL as the owner of this file's database. */
async function asOwner<T>(work: (db: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(inDatabase(ownerDatabaseUrl()));
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  const server = await connect(ownerDatabaseUrl());
  try {
    await server.query(`CREATE DATABASE ${NAME} TEMPLATE template0`);
  } finally {
    await server.end();
  }
  await asOwner(async (db) => {
    await db.query(schema);
    if (new URL(appUrl()).username === 'ims_app') await db.query(appGrants);
  });
});

afterAll(async () => {
  const server = await connect(ownerDatabaseUrl());
  try {
    await server.query(`DROP DATABASE ${NAME} WITH (FORCE)`);
  } finally {
    await server.end();
  }
});

beforeEach(() => asOwner((db) => db.query("UPDATE employees SET role = 'Employee' WHERE role = 'Admin'")));

function newClient() {
  const ip = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  return new TestClient((request) => api.fetch(request, { DATABASE_URL: appUrl() }), ip);
}

/** Signs in through the real Google flow, on this file's database; the role is then set directly (the first-Admin step). */
async function staff(role: 'Admin' | 'HR' | 'Employee' = 'Admin') {
  const client = newClient();
  const email = uniqueEmail(COMPANY_DOMAIN);
  const response = await client.post('/api/auth/staff/google', {
    idToken: await api.google.issue(email, COMPANY_DOMAIN),
  });
  expect(response.status).toBe(200);
  const { id } = await body<{ id: string }>(response);
  if (role !== 'Employee') await asOwner((db) => db.query('UPDATE employees SET role = $1 WHERE id = $2', [role, id]));
  return { client, id, email };
}

const change = (actor: { client: TestClient }, targetId: string, role: string) =>
  actor.client.put(`/api/admin/users/${targetId}/role`, { role });

const roleOf = (id: string) =>
  asOwner(
    async (db) => (await db.query<{ role: string }>('SELECT role FROM employees WHERE id = $1', [id])).rows[0]!.role,
  );

const adminIds = () =>
  asOwner(async (db) =>
    (await db.query<{ id: string }>("SELECT id FROM employees WHERE role = 'Admin' ORDER BY id")).rows.map((r) => r.id),
  );

const auditCount = () =>
  asOwner(async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE table_name = 'employees' AND operation = 'UPDATE'",
    );
    return rows[0]!.n;
  });

const expectRefused = async (response: Response, status: number, code: string) => {
  expect(response.status).toBe(status);
  expect(await body(response)).toMatchObject({ status, code });
};

/**
 * Takes the same locks a role change takes, in a transaction of its own, and runs `whileHeld` with them. A request sent
 * meanwhile passes authorization and then waits at the lock, which makes the races below happen every time. `whileHeld`
 * hands pending requests back inside an object: returning a promise itself would wait for it before the locks are freed.
 */
async function holdingAdminLocks<T>(whileHeld: (db: pg.Client) => Promise<T>): Promise<T> {
  return asOwner(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query("SELECT id FROM employees WHERE role = 'Admin' ORDER BY id FOR NO KEY UPDATE");
      const result = await whileHeld(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Waits until `count` connections of this database are waiting for a lock (fails rather than hanging). It uses its own
 * connection: inside a transaction, such as the one holding the locks, pg_stat_activity does not change between reads.
 */
async function waitForBlocked(count: number) {
  await asOwner(async (db) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (rows[0]!.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Expected ${count} blocked connection(s).`);
  });
}

describe('AUD-02: an Admin never changes their own role', () => {
  it('refuses the only Admin demoting themself, changes nothing and records nothing', async () => {
    const only = await staff();
    const before = await auditCount();
    await expectRefused(await change(only, only.id, 'Employee'), 403, 'employee.self_role_change');
    expect(await roleOf(only.id)).toBe('Admin');
    expect(await adminIds()).toEqual([only.id]);
    expect(await auditCount()).toBe(before);
  });

  it('refuses it even when other Admins exist, whatever the role and however the id is written', async () => {
    const admin = await staff();
    await staff();
    const before = await auditCount();
    for (const role of ['Employee', 'HR', 'Admin']) {
      await expectRefused(await change(admin, admin.id, role), 403, 'employee.self_role_change');
    }
    await expectRefused(await change(admin, admin.id.toUpperCase(), 'HR'), 403, 'employee.self_role_change');
    expect(await roleOf(admin.id)).toBe('Admin');
    expect(await auditCount()).toBe(before);
  });
});

describe('AUD-03: an Admin may change another Admin while an Admin remains', () => {
  it('demotes the other Admin, applies at once to their session, and is audited with the actor', async () => {
    const first = await staff();
    const second = await staff();
    expect((await second.client.get('/api/admin/users')).status).toBe(200);

    const response = await change(first, second.id, 'Employee');
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id: second.id, role: 'Employee', email: second.email });
    expect(await adminIds()).toEqual([first.id]);

    // Their session stays valid; the new role applies to it immediately.
    expect(await body(await second.client.get('/api/auth/me'))).toMatchObject({ id: second.id, role: 'Employee' });
    expect((await second.client.get('/api/admin/users')).status).toBe(403);
    expect((await first.client.get('/api/admin/users')).status).toBe(200);

    const audit = await asOwner(async (db) => {
      const { rows } = await db.query(
        `SELECT actor_type, actor_id, old_values, new_values FROM audit_logs
          WHERE table_name = 'employees' AND entity_id = $1 AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1`,
        [second.id],
      );
      return rows[0];
    });
    expect(audit).toEqual({
      actor_type: 'Staff',
      actor_id: first.id,
      old_values: { role: 'Admin' },
      new_values: { role: 'Employee' },
    });
  });

  it('promotes an Employee to Admin, and the new Admin can then change the first', async () => {
    const first = await staff();
    const employee = await staff('Employee');
    expect((await change(first, employee.id, 'Admin')).status).toBe(200);
    expect((await employee.client.get('/api/admin/users')).status).toBe(200);
    expect((await adminIds()).sort()).toEqual([first.id, employee.id].sort());

    expect((await change(employee, first.id, 'HR')).status).toBe(200);
    expect(await adminIds()).toEqual([employee.id]);
    // The remaining Admin is the only one, and still cannot demote themself.
    await expectRefused(await change(employee, employee.id, 'HR'), 403, 'employee.self_role_change');
  });

  it('still answers as before: an unchanged role changes nothing, an unknown account is 404, a bad role is 400', async () => {
    const admin = await staff();
    const other = await staff('HR');
    const before = await auditCount();
    expect((await change(admin, other.id, 'HR')).status).toBe(200);
    expect(await auditCount()).toBe(before);
    expect((await change(admin, crypto.randomUUID(), 'HR')).status).toBe(404);
    await expectRefused(await change(admin, other.id, 'Trainee'), 400, 'employee.invalid_role');
    expect(await roleOf(other.id)).toBe('HR');
  });
});

describe('role management stays Admin only', () => {
  it.each(['Employee', 'HR'] as const)('refuses %s, for themself and for anyone else', async (role) => {
    const admin = await staff();
    const caller = await staff(role);
    const other = await staff('Employee');
    const before = await auditCount();
    for (const [target, wanted] of [
      [caller.id, 'Admin'],
      [other.id, 'HR'],
      [admin.id, 'Employee'],
    ] as const) {
      expect((await change(caller, target, wanted)).status).toBe(403);
    }
    expect(await roleOf(caller.id)).toBe(role);
    expect(await roleOf(other.id)).toBe('Employee');
    expect(await adminIds()).toEqual([admin.id]);
    expect(await auditCount()).toBe(before);
  });

  it('refuses anyone signed out', async () => {
    const admin = await staff();
    expect((await newClient().put(`/api/admin/users/${admin.id}/role`, { role: 'HR' })).status).toBe(401);
    expect(await roleOf(admin.id)).toBe('Admin');
  });
});

describe('AUD-01: simultaneous changes never leave zero Admins', () => {
  it('refuses demoting the last Admin when the other Admin lost the role while the request waited', async () => {
    const remaining = await staff();
    const caller = await staff();
    const { pending } = await holdingAdminLocks(async (db) => {
      const request = change(caller, remaining.id, 'Employee'); // passes authorization: `caller` is still an Admin
      await waitForBlocked(1);
      await db.query("UPDATE employees SET role = 'Employee' WHERE id = $1", [caller.id]);
      return { pending: request };
    });
    await expectRefused(await pending, 409, 'employee.last_admin');
    expect(await adminIds()).toEqual([remaining.id]);
  });

  it('refuses a caller who lost the Admin role while the request waited, even when another Admin would remain', async () => {
    const remaining = await staff();
    const target = await staff();
    const caller = await staff();
    const { pending } = await holdingAdminLocks(async (db) => {
      const request = change(caller, target.id, 'Employee');
      await waitForBlocked(1);
      await db.query("UPDATE employees SET role = 'Employee' WHERE id = $1", [caller.id]);
      return { pending: request };
    });
    expect((await pending).status).toBe(403);
    expect((await adminIds()).sort()).toEqual([remaining.id, target.id].sort());
  });

  it('with both requests past authorization, two Admins demoting each other leaves exactly one Admin', async () => {
    const first = await staff();
    const second = await staff();
    const before = await auditCount();
    const { pending } = await holdingAdminLocks(async () => {
      const requests = Promise.all([change(first, second.id, 'Employee'), change(second, first.id, 'Employee')]);
      await waitForBlocked(2);
      return { pending: requests };
    });
    const responses = await pending;

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = responses.find((r) => r.status === 409)!;
    expect(await body(refused)).toMatchObject({ code: 'employee.last_admin' });
    expect(await adminIds()).toHaveLength(1);
    expect(await auditCount()).toBe(before + 1); // only the change that happened
  });

  it('survives unsynchronised requests: pairs, and a cycle of three, always leave an Admin', async () => {
    for (let round = 0; round < 6; round++) {
      await asOwner((db) => db.query("UPDATE employees SET role = 'Employee' WHERE role = 'Admin'"));
      const [a, b] = [await staff(), await staff()] as const;
      const pair = await Promise.all([change(a, b.id, 'HR'), change(b, a.id, 'HR')]);
      expect(pair.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await adminIds()).toHaveLength(1);

      await asOwner((db) => db.query("UPDATE employees SET role = 'Employee' WHERE role = 'Admin'"));
      const [x, y, z] = [await staff(), await staff(), await staff()] as const;
      await Promise.all([change(x, y.id, 'Employee'), change(y, z.id, 'Employee'), change(z, x.id, 'Employee')]);
      expect((await adminIds()).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('a role change does not wait for sign-ins: their foreign-key locks do not conflict with its locks', async () => {
    const admin = await staff();
    const other = await staff();
    await asOwner(async (db) => {
      await db.query('BEGIN');
      await db.query('SELECT id FROM employees WHERE id = ANY($1) FOR KEY SHARE', [[admin.id, other.id]]);
      expect((await change(admin, other.id, 'HR')).status).toBe(200); // would time out if it had to wait
      await db.query('COMMIT');
    });
    expect(await roleOf(other.id)).toBe('HR');
  });

  it('does not block sign-ins or reads while a role change holds the locks', async () => {
    const admin = await staff();
    await holdingAdminLocks(async () => {
      // A new session for an Admin takes a foreign-key lock on that Admin's row.
      const response = await newClient().post('/api/auth/staff/google', {
        idToken: await api.google.issue(admin.email, COMPANY_DOMAIN),
      });
      expect(response.status).toBe(200);
      expect((await admin.client.get('/api/admin/users')).status).toBe(200);
    });
  });
});
