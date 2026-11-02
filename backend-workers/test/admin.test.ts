import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Bindings } from '../src/config';
import { Database } from '../src/db';
import { ConcurrencyError } from '../src/domain/errors';
import { updateOrConflict } from '../src/db';
import { body, createTestApi, seedEmployee, signInStaff, signInTrainee, unique, withDb } from './helpers';

/** The Admin module end-to-end: HTTP → Worker → PostgreSQL, including permissions and audit. Port of AdminApiTests. */
const api = createTestApi();
const ENDPOINTS = [
  '/api/admin/fields',
  '/api/admin/evaluation-criteria',
  '/api/admin/users',
  '/api/admin/settings/notifications',
];

describe('permissions (PDF §2: only Admin manages fields, criteria, users)', () => {
  it.each(ENDPOINTS)('anonymous GET %s is 401', async (url) => {
    const response = await api.client().get(url);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(await body(response)).toMatchObject({
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.2',
      title: 'Unauthorized',
      status: 401,
    });
  });

  it.each(['HR', 'Employee'] as const)('%s gets 403 everywhere in the Admin module', async (role) => {
    const { client } = await signInStaff(api, role);
    for (const url of ENDPOINTS) {
      const response = await client.get(url);
      expect(response.status, url).toBe(403);
      expect(await body(response)).toMatchObject({ title: 'Forbidden', status: 403 });
    }
  });

  it('a trainee gets 403 everywhere in the Admin module', async () => {
    const { client } = await signInTrainee(api);
    for (const url of ENDPOINTS) expect((await client.get(url)).status, url).toBe(403);
  });
});

describe('fields', () => {
  it('Admin creates, edits and deactivates a field', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const name = unique('Frontend');

    const createdResponse = await client.post('/api/admin/fields', { name, description: 'React' });
    expect(createdResponse.status).toBe(201);
    const created = await body(createdResponse);
    expect(createdResponse.headers.get('location')).toBe(`/api/admin/fields/${created.id}`);
    expect(created).toEqual({ id: created.id, name, description: 'React', isActive: true });

    const updated = await body(
      await client.put(`/api/admin/fields/${created.id}`, { name, description: 'React & UI', isActive: false }),
    );
    expect(updated).toEqual({ id: created.id, name, description: 'React & UI', isActive: false });

    const list = await body<{ id: string; isActive: boolean }[]>(await client.get('/api/admin/fields'));
    expect(list.find((f) => f.id === created.id)?.isActive).toBe(false);
  });

  it('names are trimmed; an empty description is stored as null', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const name = unique('Trimmed');
    const created = await body(await client.post('/api/admin/fields', { name: `  ${name}  `, description: '   ' }));
    expect(created).toMatchObject({ name, description: null });
  });

  it('field names are unique ignoring case (409)', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const name = unique('QA');
    expect((await client.post('/api/admin/fields', { name, description: null })).status).toBe(201);

    const duplicate = await client.post('/api/admin/fields', { name: name.toUpperCase(), description: null });
    expect(duplicate.status).toBe(409);
    expect(await body(duplicate)).toMatchObject({
      status: 409,
      code: 'conflict.duplicate',
      detail: 'A record with the same value already exists.',
    });
  });

  it('invalid or unknown fields are rejected', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const empty = await client.post('/api/admin/fields', { name: '', description: null });
    expect(empty.status).toBe(400);
    expect((await body(empty)).errors).toEqual({ Name: ['The Name field is required.'] });

    const tooLong = await client.post('/api/admin/fields', { name: 'x'.repeat(101), description: 'y'.repeat(1001) });
    expect((await body(tooLong)).errors).toEqual({
      Name: ["The field Name must be a string or array type with a maximum length of '100'."],
      Description: ["The field Description must be a string or array type with a maximum length of '1000'."],
    });

    const id = crypto.randomUUID();
    const unknown = await client.put(`/api/admin/fields/${id}`, { name: 'X', description: null, isActive: true });
    expect(unknown.status).toBe(404);
    expect(await body(unknown)).toMatchObject({
      status: 404,
      code: 'not_found',
      detail: `Field '${id}' was not found.`,
    });
  });

  it('an update that changes nothing writes nothing', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const created = await body(await client.post('/api/admin/fields', { name: unique('Same'), description: 'd' }));
    await client.put(`/api/admin/fields/${created.id}`, { name: created.name, description: 'd', isActive: true });
    const audit = await withDb((db) => db.query('SELECT operation FROM audit_logs WHERE entity_id = $1', [created.id]));
    expect(audit.rows).toEqual([{ operation: 'INSERT' }]);
  });
});

describe('evaluation criteria', () => {
  it('Admin manages criteria and weights in order', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const second = await body(
      await client.post('/api/admin/evaluation-criteria', { name: unique('Teamwork'), weight: 1, sortOrder: 2 }),
    );
    const firstResponse = await client.post('/api/admin/evaluation-criteria', {
      name: unique('Technical'),
      weight: 3,
      sortOrder: 1,
    });
    expect(firstResponse.status).toBe(201);
    const first = await body(firstResponse);

    const updated = await body(
      await client.put(`/api/admin/evaluation-criteria/${second.id}`, { name: second.name, weight: 2.5, sortOrder: 2 }),
    );
    expect(updated.weight).toBe(2.5);

    const list = await body<{ id: string; weight: number }[]>(await client.get('/api/admin/evaluation-criteria'));
    expect(list.findIndex((c) => c.id === first.id)).toBeLessThan(list.findIndex((c) => c.id === second.id));
    expect(list.find((c) => c.id === second.id)?.weight).toBe(2.5);
  });

  it('a weight must be positive (400) and at most 99999', async () => {
    const { client } = await signInStaff(api, 'Admin');
    for (const weight of [0, -1, 100000]) {
      const response = await client.post('/api/admin/evaluation-criteria', { name: 'Zero', weight, sortOrder: 1 });
      expect(response.status).toBe(400);
      expect((await body(response)).errors).toEqual({ Weight: ['The field Weight must be between 0.0001 and 99999.'] });
    }
  });

  it('numbers may be sent as strings (System.Text.Json web defaults)', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const response = await client.post('/api/admin/evaluation-criteria', {
      name: unique('Strings'),
      weight: '1.5',
      sortOrder: '4',
    });
    expect(response.status).toBe(201);
    expect(await body(response)).toMatchObject({ weight: 1.5, sortOrder: 4 });
  });
});

describe('users and roles', () => {
  it('Admin grants higher roles to staff', async () => {
    const employee = await seedEmployee();
    const { client } = await signInStaff(api, 'Admin');

    const users = await body<{ id: string; role: string; fullName: string; department: string | null }[]>(
      await client.get('/api/admin/users'),
    );
    expect(users.find((u) => u.id === employee.id)).toEqual({
      id: employee.id,
      fullName: 'New Employee',
      email: employee.email,
      department: null,
      role: 'Employee',
    });

    const promoted = await client.put(`/api/admin/users/${employee.id}/role`, { role: 'HR' });
    expect(promoted.status).toBe(200);
    expect((await body(promoted)).role).toBe('HR');
    const stored = await withDb((db) => db.query('SELECT role FROM employees WHERE id = $1', [employee.id]));
    expect(stored.rows[0].role).toBe('HR');
  });

  it('accepts the role as a name in any case or as its number (JsonStringEnumConverter)', async () => {
    const employee = await seedEmployee();
    const { client } = await signInStaff(api, 'Admin');
    expect((await body(await client.put(`/api/admin/users/${employee.id}/role`, { role: 'admin' }))).role).toBe(
      'Admin',
    );
    expect((await body(await client.put(`/api/admin/users/${employee.id}/role`, { role: 1 }))).role).toBe('HR');
  });

  it('staff cannot be given the Trainee role; unknown users are 404; unknown roles are 400', async () => {
    const employee = await seedEmployee();
    const { client } = await signInStaff(api, 'Admin');

    const trainee = await client.put(`/api/admin/users/${employee.id}/role`, { role: 'Trainee' });
    expect(trainee.status).toBe(400);
    expect(await body(trainee)).toMatchObject({
      code: 'employee.invalid_role',
      detail: "A staff member's role must be Employee, HR or Admin.",
    });
    expect((await client.put(`/api/admin/users/${employee.id}/role`, { role: 7 })).status).toBe(400);
    expect((await client.put(`/api/admin/users/${employee.id}/role`, { role: 'Owner' })).status).toBe(400);

    const unknown = await client.put(`/api/admin/users/${crypto.randomUUID()}/role`, { role: 'HR' });
    expect(unknown.status).toBe(404);
  });

  it('a missing role is rejected instead of defaulting to Admin (deliberate difference from C#)', async () => {
    const employee = await seedEmployee();
    const { client } = await signInStaff(api, 'Admin');
    const response = await client.put(`/api/admin/users/${employee.id}/role`, {});
    expect(response.status).toBe(400);
    expect((await body(response)).errors).toEqual({ Role: ['The Role field is required.'] });
    const stored = await withDb((db) => db.query('SELECT role FROM employees WHERE id = $1', [employee.id]));
    expect(stored.rows[0].role).toBe('Employee');
  });
});

describe('notification settings (PDF §7: 7 / 3 / 5 days)', () => {
  it('Admin changes the notification intervals', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const current = await body(await client.get('/api/admin/settings/notifications'));
    expect(Object.keys(current)).toEqual([
      'trainingEndingNoticeDays',
      'lateEvaluationReminderDays',
      'pendingRequestAlertDays',
    ]);

    const values = { trainingEndingNoticeDays: 10, lateEvaluationReminderDays: 2, pendingRequestAlertDays: 4 };
    expect(await body(await client.put('/api/admin/settings/notifications', values))).toEqual(values);
    expect(await body(await client.get('/api/admin/settings/notifications'))).toEqual(values);

    const invalid = await client.put('/api/admin/settings/notifications', { ...values, trainingEndingNoticeDays: 0 });
    expect(invalid.status).toBe(400);
    expect((await body(invalid)).errors).toEqual({
      TrainingEndingNoticeDays: ['The field TrainingEndingNoticeDays must be between 1 and 365.'],
    });

    await client.put('/api/admin/settings/notifications', current); // restore for other tests
  });
});

describe('database integrity (PDF §6, §8): roles, audit log, no hard deletes', () => {
  it('the database holds exactly the four roles', async () => {
    const roles = await withDb((db) => db.query('SELECT code FROM roles ORDER BY code'));
    expect(roles.rows.map((r) => r.code)).toEqual(['Admin', 'Employee', 'HR', 'Trainee']);
  });

  it('Admin changes are recorded in the audit log with the Admin as actor', async () => {
    const { client, user } = await signInStaff(api, 'Admin');
    const field = await body(await client.post('/api/admin/fields', { name: unique('Design') }));
    const entry = await withDb((db) =>
      db.query('SELECT operation, table_name, actor_type, actor_id FROM audit_logs WHERE entity_id = $1', [field.id]),
    );
    expect(entry.rows).toEqual([{ operation: 'INSERT', table_name: 'fields', actor_type: 'Staff', actor_id: user.id }]);
  });

  it.each([
    'DELETE FROM fields',
    'DELETE FROM employees',
    'DELETE FROM evaluation_criteria',
    'DELETE FROM roles',
    'DELETE FROM trainees',
    'DELETE FROM trainee_sign_in_codes',
    'TRUNCATE notification_settings',
    'DELETE FROM audit_logs',
  ])('records cannot be deleted: %s', async (sql) => {
    await seedEmployee();
    await signInTrainee(api);
    const { client } = await signInStaff(api, 'Admin');
    await client.post('/api/admin/fields', { name: unique('Seed') });
    await client.post('/api/admin/evaluation-criteria', { name: unique('Seed'), weight: 1, sortOrder: 1 });

    const error = await withDb((db) =>
      db.query(sql).then(
        () => null,
        (e: { code: string }) => e,
      ),
    );
    expect(error?.code).toBe(sql.includes('audit_logs') ? '42501' : '23001'); // insufficient_privilege / restrict_violation
  });

  it('an update of a row changed by someone else since it was read is a conflict (xmin)', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const field = await body(await client.post('/api/admin/fields', { name: unique('Race') }));
    const db = new Database((env as unknown as Bindings).DATABASE_URL!);
    try {
      const { rows } = await db.query<{ version: string }>('SELECT xmin::text AS version FROM fields WHERE id = $1', [
        field.id,
      ]);
      await client.put(`/api/admin/fields/${field.id}`, { name: field.name, description: 'changed', isActive: true });
      const stale = db.transaction({ type: 'System', id: null }, (tx) =>
        updateOrConflict(tx, 'UPDATE fields SET is_active = false WHERE id = $1 AND xmin = $2::xid', [
          field.id,
          rows[0]!.version,
        ]),
      );
      await expect(stale).rejects.toBeInstanceOf(ConcurrencyError);
    } finally {
      await db.close();
    }
  });
});
