import { describe, expect, it } from 'vitest';
import { body, createTestApi, setRole, signInStaff, signInTrainee, type TestClient, unique, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * Actor names in the Admin audit log viewer: each entry names who acted, from the account tables (never from the stored
 * values). Synthetic records only: fields made with a chosen audit actor stand in for System, Database and an unknown
 * account, through the database triggers; no audit record is written or changed directly.
 */
const api = createTestApi();

interface Entry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorKnown: boolean;
  actorName: string | null;
  actorCurrentRole: string | null;
  table: string;
  entityId: string | null;
}

const read = async (admin: TestClient, query: string) => {
  const response = await admin.get(`/api/admin/audit-logs${query}`);
  expect(response.status, query).toBe(200);
  return (await body<{ hasMore: boolean; entries: Entry[] }>(response)).entries;
};

/** A field inserted with the given audit actor settings (none = the Database actor); returns its id. */
async function fieldAs(actorType: string | null, actorId: string | null = null) {
  const id = crypto.randomUUID();
  await withDb(async (db) => {
    await db.query('BEGIN');
    if (actorType) {
      await db.query("SELECT set_config('ims.actor_type', $1, true), set_config('ims.actor_id', $2, true)", [
        actorType,
        actorId ?? '',
      ]);
    }
    await db.query('INSERT INTO fields (id, name, description, is_active) VALUES ($1, $2, NULL, true)', [
      id,
      unique('Synthetic field'),
    ]);
    await db.query('COMMIT');
  });
  return id;
}

const actor = (e: Entry) => ({
  actorType: e.actorType,
  actorKnown: e.actorKnown,
  actorName: e.actorName,
  actorCurrentRole: e.actorCurrentRole,
});

describe('audit log viewer: actor names', () => {
  it('names staff with their current role, and trainees, from their accounts', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    await withDb((db) =>
      db.query("UPDATE employees SET full_name = 'Synthetic HR Person' WHERE id = $1", [hr.user.id]),
    );
    const field = await newField(admin.client);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id, 'Synthetic Trainee Name');
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);

    const [decision] = await read(admin.client, `?actorId=${hr.user.id}&table=training_applications`);
    expect(actor(decision!)).toEqual({
      actorType: 'Staff',
      actorKnown: true,
      actorName: 'Synthetic HR Person',
      actorCurrentRole: 'HR',
    });
    expect(decision!.actorId).toBe(hr.user.id); // the recorded actor id is kept

    const submitted = await read(admin.client, `?actorId=${trainee.user.id}&table=training_applications`);
    expect(submitted.map(actor)).toEqual([
      { actorType: 'Trainee', actorKnown: true, actorName: 'Synthetic Trainee Name', actorCurrentRole: null },
    ]);

    // The role shown is the current one: after a role change, earlier entries show the new role.
    await setRole(hr.email, 'Employee');
    const [same] = await read(admin.client, `?actorId=${hr.user.id}&table=training_applications`);
    expect(same!.id).toBe(decision!.id);
    expect(same!.actorCurrentRole).toBe('Employee');
  });

  it('gives no name for actors without an account, and says when an account is not found', async () => {
    const admin = await signInStaff(api, 'Admin');
    const system = await fieldAs('System');
    const database = await fieldAs(null);
    const unknownStaff = await fieldAs('Staff', crypto.randomUUID());
    const unknownTrainee = await fieldAs('Trainee', crypto.randomUUID());
    const entries = await read(admin.client, '?table=fields&operation=INSERT');
    const byEntity = (id: string) => entries.find((e) => e.entityId === id)!;

    expect(actor(byEntity(system))).toEqual({
      actorType: 'System',
      actorKnown: false,
      actorName: null,
      actorCurrentRole: null,
    });
    expect(actor(byEntity(database))).toEqual({
      actorType: 'Database',
      actorKnown: false,
      actorName: null,
      actorCurrentRole: null,
    });
    expect(actor(byEntity(unknownStaff))).toEqual({
      actorType: 'Staff',
      actorKnown: false,
      actorName: null,
      actorCurrentRole: null,
    });
    expect(actor(byEntity(unknownTrainee))).toMatchObject({ actorType: 'Trainee', actorKnown: false, actorName: null });
  });

  it('names nobody for unverified sign-in writes (Anonymous), and a known trainee without a name yet as such', async () => {
    const admin = await signInStaff(api, 'Admin');
    const trainee = await signInTrainee(api);
    // The code request comes before any verification: Anonymous, no name.
    const requests = await read(admin.client, '?table=trainee_sign_in_codes&actorType=Anonymous&operation=INSERT');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((e) => actor(e).actorName === null && !e.actorKnown)).toBe(true);
    // The account is created once the code is verified: recorded as the trainee, known, without a name yet.
    const created = await read(admin.client, `?table=trainees&actorId=${trainee.user.id}&operation=INSERT`);
    expect(created.map(actor)).toEqual([
      { actorType: 'Trainee', actorKnown: true, actorName: null, actorCurrentRole: null },
    ]);

    // Signing out is recorded as the trainee, who has not entered a name.
    expect((await trainee.client.post('/api/auth/sign-out')).status).toBe(204);
    const [signOut] = await read(admin.client, `?actorId=${trainee.user.id}&table=user_sessions`);
    expect(actor(signOut!)).toEqual({
      actorType: 'Trainee',
      actorKnown: true,
      actorName: null,
      actorCurrentRole: null,
    });
  });

  it('keeps names right across pages and filters, without other personal data', async () => {
    const admin = await signInStaff(api, 'Admin');
    await withDb((db) =>
      db.query("UPDATE employees SET full_name = 'Synthetic Admin Person' WHERE id = $1", [admin.user.id]),
    );
    for (let i = 0; i < 53; i++) await newField(admin.client);

    const first = await body<{ hasMore: boolean; entries: Entry[] }>(
      await admin.client.get(`/api/admin/audit-logs?actorId=${admin.user.id}&table=fields`),
    );
    const second = await read(
      admin.client,
      `?actorId=${admin.user.id}&table=fields&before=${first.entries.at(-1)!.id}`,
    );
    expect(first.hasMore).toBe(true);
    const all = [...first.entries, ...second];
    expect(all).toHaveLength(53);
    expect(new Set(all.map((e) => e.id)).size).toBe(53);
    expect(all.every((e) => e.actorName === 'Synthetic Admin Person' && e.actorCurrentRole === 'Admin')).toBe(true);

    const text = JSON.stringify(all);
    expect(text).not.toContain(admin.email);
    expect(text).not.toMatch(/email|phone|old_?values|new_?values|code_?hash|token_?hash|storage_?key/i);
    expect(Object.keys(all[0]!).sort()).toEqual([
      'actorCurrentRole',
      'actorId',
      'actorKnown',
      'actorName',
      'actorType',
      'entityId',
      'id',
      'occurredAt',
      'operation',
      'table',
    ]);
  });

  it('is still Admin-only and changes nothing', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    await newField(admin.client);
    const snapshot = () =>
      withDb((db) =>
        db.query('SELECT id, xmin::text FROM audit_logs WHERE actor_id = $1 ORDER BY id', [admin.user.id]),
      ).then((r) => r.rows);
    const before = await snapshot();
    await read(admin.client, `?actorId=${admin.user.id}`);
    expect(await snapshot()).toEqual(before);
    expect((await hr.client.get('/api/admin/audit-logs')).status).toBe(403);
    expect((await api.client().get('/api/admin/audit-logs')).status).toBe(401);
  });
});
