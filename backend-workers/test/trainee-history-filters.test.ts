import { describe, expect, it } from 'vitest';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Filters of the HR report «سجل المتدرب» (PDF §6 "every report is filtered by period and field"), on its trainings only:
 * a period keeps the assignments whose recorded dates overlap it (inclusive), a field those of applications in that
 * field. Every application and every contact note of the trainee is still returned. The Accepted-only eligibility
 * (owner decision 2026-11-02) is unchanged.
 */
const api = createTestApi();

interface History {
  totalTrainings: number;
  trainee: { id: string };
  applications: {
    id: string;
    status: string;
    fieldId: string;
    fieldName: string;
    assignments: { id: string; startDate: string; endDate: string; status: string }[];
    contactLogs: { id: string; summary: string }[];
  }[];
}

/**
 * One trainee with a long history: in field A an accepted application with two assignments (January, then March), in
 * field B an accepted application with one (February) and a rejected application without any; a contact note on each.
 */
async function history() {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const fieldA = await newField(admin.client);
  const fieldB = await newField(admin.client);
  const trainee = await signInTrainee(api);

  const inA = await submitApplication(trainee.client, fieldA.id, 'History Trainee');
  const inB = await submitApplication(trainee.client, fieldB.id, 'History Trainee');
  const rejectedInB = await submitApplication(trainee.client, fieldB.id, 'History Trainee');
  expect((await hr.client.post(`/api/hr/applications/${inA}/accept`)).status).toBe(200);
  expect((await hr.client.post(`/api/hr/applications/${inB}/accept`)).status).toBe(200);
  expect((await hr.client.post(`/api/hr/applications/${rejectedInB}/reject`, { reason: 'Full' })).status).toBe(200);

  const january = await seedAssignment(inA, employee.user.id, '2031-01-01', '2031-01-31', 'Transferred');
  const march = await seedAssignment(inA, employee.user.id, '2031-03-01', '2031-03-31', 'Active');
  const february = await seedAssignment(inB, employee.user.id, '2031-02-10', '2031-02-20', 'Withdrawn');

  const notes: string[] = [];
  for (const [applicationId, summary] of [
    [inA, 'Note on A'],
    [inB, 'Note on B'],
    [rejectedInB, 'Note on the rejected one'],
  ] as const) {
    const added = await hr.client.post(`/api/hr/applications/${applicationId}/contact-logs`, {
      contactDate: '2030-12-15',
      method: 'Phone',
      summary,
    });
    expect(added.status).toBe(201);
    notes.push((await body<{ id: string }>(added)).id);
  }

  const read = async (query = '') => {
    const response = await hr.client.get(`/api/hr/trainees/${trainee.user.id}/history${query}`);
    expect(response.status, query).toBe(200);
    return body<History>(response);
  };
  return {
    admin,
    hr,
    employee,
    trainee,
    fieldA,
    fieldB,
    applications: { inA, inB, rejectedInB },
    assignments: { january, march, february },
    notes,
    read,
  };
}

const trainings = (h: History) => h.applications.flatMap((a) => a.assignments.map((s) => s.id));
const contactNotes = (h: History) => h.applications.flatMap((a) => a.contactLogs.map((l) => l.id)).sort();

describe('trainee history: filters on the trainings (PDF §6)', () => {
  it('filters the trainings by period and field, and never the applications or contact notes', async () => {
    const h = await history();
    const { january, march, february } = h.assignments;

    // No filter: everything, as before; each application says its field.
    const all = await h.read();
    expect(all.applications.map((a) => [a.id, a.status, a.fieldId])).toEqual([
      [h.applications.inA, 'Accepted', h.fieldA.id],
      [h.applications.inB, 'Accepted', h.fieldB.id],
      [h.applications.rejectedInB, 'Rejected', h.fieldB.id],
    ]);
    expect(trainings(all)).toEqual([january, march, february]);
    expect(contactNotes(all)).toEqual([...h.notes].sort());

    const cases: [string, string[]][] = [
      // Period: overlap with the recorded dates, both ends included.
      ['?from=2031-02-01&to=2031-02-28', [february]],
      ['?from=2031-01-31&to=2031-03-01', [january, march, february]], // ends on the start, starts on the end
      ['?from=2031-02-01&to=2031-02-09', []], // between January and the February assignment
      ['?from=2031-02-21&to=2031-02-28', []],
      ['?from=2031-03-31', [march]], // only a start: from that day on
      ['?to=2031-01-01', [january]], // only an end: up to that day
      ['?from=2031-02-20&to=2031-02-20', [february]], // one day
      // Field: the field of each training's application.
      [`?fieldId=${h.fieldA.id}`, [january, march]],
      [`?fieldId=${h.fieldB.id}`, [february]],
      // Both.
      [`?fieldId=${h.fieldA.id}&from=2031-02-01&to=2031-03-15`, [march]],
      [`?fieldId=${h.fieldB.id}&from=2031-03-01`, []],
      // Empty values mean "no filter".
      ['?from=&to=&fieldId=', [january, march, february]],
    ];
    for (const [query, expected] of cases) {
      const filtered = await h.read(query);
      expect(trainings(filtered), query).toEqual(expected);
      // The rest of the report is unchanged: every application, and every contact note.
      expect(
        filtered.applications.map((a) => a.id),
        query,
      ).toEqual(all.applications.map((a) => a.id));
      expect(contactNotes(filtered), query).toEqual(contactNotes(all));
      // The total is every training of the trainee, never the filtered number.
      expect(filtered.totalTrainings, query).toBe(3);
    }
  });

  it('gives the total number of trainings of the trainee: none, one, then more', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const employee = await signInStaff(api, 'Employee');
    const field = await newField(admin.client);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    const total = async (query = '') =>
      (await body<History>(await hr.client.get(`/api/hr/trainees/${trainee.user.id}/history${query}`))).totalTrainings;

    expect(await total()).toBe(0);
    await seedAssignment(applicationId, employee.user.id, '2031-01-01', '2031-01-31', 'Transferred');
    expect(await total()).toBe(1);
    await seedAssignment(applicationId, employee.user.id, '2031-02-01', '2031-02-28', 'Active');
    expect(await total()).toBe(2);
    expect(await total('?from=2031-02-01')).toBe(2); // not the filtered number
  });

  it('refuses malformed filters', async () => {
    const h = await history();
    for (const query of [
      '?from=2031-02-30',
      '?to=31-01-2031',
      '?from=x',
      '?fieldId=nope',
      '?from=2031-03-01&to=2031-02-01',
    ]) {
      const response = await h.hr.client.get(`/api/hr/trainees/${h.trainee.user.id}/history${query}`);
      expect(response.status, query).toBe(400);
    }
  });

  it('keeps the Accepted-only eligibility and HR-only access, with or without filters', async () => {
    const h = await history();
    const field = h.fieldA.id;

    // A trainee whose only application is not accepted stays out of the report, filters or not.
    const waiting = await signInTrainee(api);
    await submitApplication(waiting.client, field, 'Waiting Trainee');
    for (const query of ['', `?fieldId=${field}`, '?from=2031-01-01&to=2031-12-31']) {
      expect((await h.hr.client.get(`/api/hr/trainees/${waiting.user.id}/history${query}`)).status).toBe(404);
    }
    const listed = await body<{ id: string }[]>(await h.hr.client.get('/api/hr/trainees'));
    expect(listed.map((t) => t.id)).toContain(h.trainee.user.id);
    expect(listed.map((t) => t.id)).not.toContain(waiting.user.id);

    const path = `/api/hr/trainees/${h.trainee.user.id}/history?fieldId=${field}&from=2031-01-01`;
    for (const client of [h.admin.client, h.employee.client, h.trainee.client] as TestClient[]) {
      expect((await client.get(path)).status).toBe(403);
    }
    expect((await api.client().get(path)).status).toBe(401);
  });

  it('changes nothing when read', async () => {
    const h = await history();
    const ids = [...Object.values(h.applications), ...Object.values(h.assignments), ...h.notes];
    const snapshot = () =>
      withDb(async (db) => ({
        rows: (
          await db.query(
            `SELECT id::text, xmin::text FROM training_applications WHERE id = ANY($1)
             UNION ALL SELECT id::text, xmin::text FROM assignments WHERE id = ANY($1)
             UNION ALL SELECT id::text, xmin::text FROM contact_logs WHERE id = ANY($1) ORDER BY 1`,
            [ids],
          )
        ).rows,
        audit: (await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ANY($1)', [ids])).rows,
      }));
    const before = await snapshot();
    expect(before.rows).toHaveLength(ids.length);
    await h.read(`?fieldId=${h.fieldA.id}&from=2031-01-01&to=2031-02-15`);
    expect(await snapshot()).toEqual(before);
  });
});
