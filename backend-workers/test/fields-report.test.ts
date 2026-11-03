import { describe, expect, it } from 'vitest';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * The fields report (PDF §6 «تقرير المجالات»), the part that is defined: for each field, the number of applications and
 * of Accepted applications (AD-47). No "completed" count (decisions.md L1) and no period or employee filter.
 */
const api = createTestApi();

interface FieldsReport {
  rows: { field: { id: string; name: string }; applications: number; accepted: number }[];
}

const fieldsReport = async (client: TestClient, query = '', area: 'hr' | 'admin' = 'hr') => {
  const response = await client.get(`/api/${area}/reports/fields${query}`);
  expect(response.status).toBe(200);
  return body<FieldsReport>(response);
};
const rowFor = (report: FieldsReport, fieldId: string) => report.rows.find((r) => r.field.id === fieldId);

describe('fields report (PDF §6)', () => {
  it('counts applications and Accepted applications per field, including fields without any', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const busy = await newField(admin.client);
    const quiet = await newField(admin.client);
    const empty = await newField(admin.client);

    // One trainee with three applications in the busy field: each counts.
    const lina = await signInTrainee(api);
    await submitApplication(lina.client, busy.id);
    const underReview = await submitApplication(lina.client, busy.id);
    const accepted = await submitApplication(lina.client, busy.id);
    expect((await hr.client.post(`/api/hr/applications/${underReview}/review`)).status).toBe(200);
    expect((await hr.client.post(`/api/hr/applications/${accepted}/accept`)).status).toBe(200);
    // Another trainee: one rejected and one accepted application in the busy field.
    const omar = await signInTrainee(api);
    const rejected = await submitApplication(omar.client, busy.id);
    const acceptedToo = await submitApplication(omar.client, busy.id);
    expect((await hr.client.post(`/api/hr/applications/${rejected}/reject`, { reason: 'Full' })).status).toBe(200);
    expect((await hr.client.post(`/api/hr/applications/${acceptedToo}/accept`)).status).toBe(200);
    // One submitted application in the quiet field.
    await submitApplication(omar.client, quiet.id);

    const statuses = await withDb((db) =>
      db.query<{ status: string }>('SELECT status FROM training_applications WHERE field_id = $1 ORDER BY status', [
        busy.id,
      ]),
    );
    expect(statuses.rows.map((r) => r.status)).toEqual([
      'Accepted',
      'Accepted',
      'Rejected',
      'Submitted',
      'UnderReview',
    ]);

    const report = await fieldsReport(hr.client);
    expect(rowFor(report, busy.id)).toEqual({ field: { id: busy.id, name: busy.name }, applications: 5, accepted: 2 });
    expect(rowFor(report, quiet.id)).toEqual({
      field: { id: quiet.id, name: quiet.name },
      applications: 1,
      accepted: 0,
    });
    expect(rowFor(report, empty.id)).toEqual({
      field: { id: empty.id, name: empty.name },
      applications: 0,
      accepted: 0,
    });
    // Every field is listed once; nothing about completion.
    expect(new Set(report.rows.map((r) => r.field.id)).size).toBe(report.rows.length);
    expect(JSON.stringify(report)).not.toMatch(/complet/i);

    // The field filter keeps that field's row only.
    expect(await fieldsReport(hr.client, `?fieldId=${busy.id}`)).toEqual({
      rows: [{ field: { id: busy.id, name: busy.name }, applications: 5, accepted: 2 }],
    });
    expect(await fieldsReport(hr.client, `?fieldId=${empty.id}`)).toEqual({
      rows: [{ field: { id: empty.id, name: empty.name }, applications: 0, accepted: 0 }],
    });
    expect(await fieldsReport(hr.client, `?fieldId=${crypto.randomUUID()}`)).toEqual({ rows: [] });
    expect(rowFor(await fieldsReport(hr.client, '?fieldId='), busy.id)).toEqual(rowFor(report, busy.id)); // empty = all
    expect((await hr.client.get('/api/hr/reports/fields?fieldId=x')).status).toBe(400);

    // The Admin gets the same report.
    expect(rowFor(await fieldsReport(admin.client, `?fieldId=${busy.id}`, 'admin'), busy.id)).toEqual(
      rowFor(report, busy.id),
    );
  });

  it('changes nothing when read', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const field = await newField(admin.client);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);
    const snapshot = () =>
      withDb(async (db) => ({
        application: (await db.query('SELECT *, xmin::text FROM training_applications WHERE id = $1', [applicationId]))
          .rows,
        field: (await db.query('SELECT *, xmin::text FROM fields WHERE id = $1', [field.id])).rows,
        audit: (
          await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ANY($1)', [
            [applicationId, field.id],
          ])
        ).rows,
      }));

    const before = await snapshot();
    await fieldsReport(hr.client);
    await fieldsReport(admin.client, `?fieldId=${field.id}`, 'admin');
    expect(await snapshot()).toEqual(before);
    for (const [client, path] of [
      [hr.client, '/api/hr/reports/fields'],
      [admin.client, '/api/admin/reports/fields'],
    ] as const) {
      expect((await client.post(path, {})).status).toBe(405);
      expect((await client.put(path, {})).status).toBe(405);
    }
  });

  it('is for HR and the Admin, each in their own area; employees, trainees and anonymous callers are refused', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const employee = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);

    expect((await admin.client.get('/api/admin/reports/fields')).status).toBe(200);
    expect((await hr.client.get('/api/hr/reports/fields')).status).toBe(200);
    expect((await admin.client.get('/api/hr/reports/fields')).status).toBe(403);
    expect((await hr.client.get('/api/admin/reports/fields')).status).toBe(403);
    for (const client of [employee.client, trainee.client]) {
      for (const path of ['/api/hr/reports/fields', '/api/admin/reports/fields']) {
        expect((await client.get(path)).status, path).toBe(403);
      }
    }
    for (const path of ['/api/hr/reports/fields', '/api/admin/reports/fields']) {
      expect((await api.client().get(path)).status, path).toBe(401);
    }
  });
});
