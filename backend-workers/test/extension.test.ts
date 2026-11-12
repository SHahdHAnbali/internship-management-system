import { describe, expect, it } from 'vitest';
import { calendarDate, extendAssignment } from '../src/domain/training';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Training extension (AD-63 L2, NEW-35, owner decisions 2026-11-12): HR extends an Active training to a planned end
 * date strictly later than the current one (also after it has passed), with a mandatory reason, any number of times;
 * every extension is kept in the insert-only `assignment_extensions`, in the same transaction as the new end date.
 */
const api = createTestApi();

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => calendarDate(new Date());

interface Extension {
  previousEndDate: string;
  newEndDate: string;
  reason: string;
  extendedAt: string;
  extendedBy: string;
}
interface Assignment {
  id: string;
  status: string;
  endDate: string;
  extensions: Extension[];
}

async function activeTraining(start: string, end: string) {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const field = await newField(admin.client);
  const trainee = await signInTrainee(api);
  const applicationId = await submitApplication(trainee.client, field.id);
  expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  const id = await seedAssignment(applicationId, employee.user.id, start, end, 'Active');
  return { admin, hr, employee, trainee, id };
}

const extend = (client: TestClient, id: string, payload: unknown) =>
  client.post(`/api/hr/assignments/${id}/extend`, payload);

const history = (id: string) =>
  withDb((db) =>
    db.query<{ previous_end_date: string; new_end_date: string; reason: string; extended_by_id: string }>(
      `SELECT previous_end_date::text, new_end_date::text, reason, extended_by_id FROM assignment_extensions
        WHERE assignment_id = $1 ORDER BY extended_at, id`,
      [id],
    ),
  ).then((r) => r.rows);
const endDate = (id: string) =>
  withDb((db) => db.query<{ end_date: string }>('SELECT end_date::text FROM assignments WHERE id = $1', [id])).then(
    (r) => r.rows[0]!.end_date,
  );

describe('extendAssignment (NEW-35 rules)', () => {
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return 'no error';
  };
  const active = { status: 'Active', plannedEndDate: '2026-11-01' };

  it('a later date and a reason: accepted, trimmed; the same or an earlier date, no reason, a bad date, or not Active: refused', () => {
    expect(extendAssignment({ endDate: '2026-11-02', reason: ' More work ' }, active)).toEqual({
      newEndDate: '2026-11-02',
      reason: 'More work',
    });
    expect(code(() => extendAssignment({ endDate: '2026-11-01', reason: 'x' }, active))).toBe(
      'assignment.extension_not_later',
    );
    expect(code(() => extendAssignment({ endDate: '2026-10-01', reason: 'x' }, active))).toBe(
      'assignment.extension_not_later',
    );
    expect(code(() => extendAssignment({ endDate: '2026-12-01', reason: '  ' }, active))).toBe('validation.required');
    expect(code(() => extendAssignment({ endDate: 'soon', reason: 'x' }, active))).toBe('validation.required');
    for (const status of ['Completed', 'EndedEarly', 'Withdrawn', 'Transferred'])
      expect(code(() => extendAssignment({ endDate: '2026-12-01', reason: 'x' }, { ...active, status }))).toBe(
        'assignment.invalid_status',
      );
  });
});

describe('HR extends a training (API)', () => {
  it('moves the end date and records the previous date, the new date, the reason, the HR user and the time; audited', async () => {
    const planned = addDays(today(), 10);
    const { hr, id } = await activeTraining(addDays(today(), -20), planned);
    const newDate = addDays(today(), 40);
    const response = await extend(hr.client, id, {
      endDate: newDate,
      reason: 'المشروع لم يكتمل / Project not finished',
    });
    expect(response.status).toBe(200);
    const assignment = await body<Assignment>(response);
    expect(assignment).toMatchObject({ id, status: 'Active', endDate: newDate });
    expect(assignment.extensions).toEqual([
      {
        previousEndDate: planned,
        newEndDate: newDate,
        reason: 'المشروع لم يكتمل / Project not finished',
        extendedAt: expect.any(String),
        extendedBy: expect.any(String),
      },
    ]);
    expect(await history(id)).toEqual([
      {
        previous_end_date: planned,
        new_end_date: newDate,
        reason: 'المشروع لم يكتمل / Project not finished',
        extended_by_id: hr.user.id,
      },
    ]);

    const audit = await withDb((db) =>
      db.query<{ table_name: string; operation: string; actor_type: string; actor_id: string }>(
        `SELECT l.table_name, l.operation, l.actor_type, l.actor_id FROM audit_logs l
          WHERE (l.table_name = 'assignments' AND l.entity_id = $1::text AND l.operation = 'UPDATE')
             OR (l.table_name = 'assignment_extensions' AND l.entity_id IN
                   (SELECT x.id::text FROM assignment_extensions x WHERE x.assignment_id = $1::uuid))
          ORDER BY l.id`,
        [id],
      ),
    );
    expect(audit.rows).toEqual([
      { table_name: 'assignment_extensions', operation: 'INSERT', actor_type: 'Staff', actor_id: hr.user.id },
      { table_name: 'assignments', operation: 'UPDATE', actor_type: 'Staff', actor_id: hr.user.id },
    ]);
  });

  it('extends a training whose planned end date has already passed, and several times with separate reasons', async () => {
    const planned = addDays(today(), -5);
    const { hr, id } = await activeTraining(addDays(today(), -60), planned);
    const first = addDays(today(), -2); // still in the past, but later than the current end date
    const second = addDays(today(), 30);
    expect((await extend(hr.client, id, { endDate: first, reason: 'First reason' })).status).toBe(200);
    expect((await extend(hr.client, id, { endDate: second, reason: 'Second reason' })).status).toBe(200);
    expect(await endDate(id)).toBe(second);
    expect((await history(id)).map((h) => [h.previous_end_date, h.new_end_date, h.reason])).toEqual([
      [planned, first, 'First reason'],
      [first, second, 'Second reason'],
    ]);
  });

  it('refuses a missing reason, the same or an earlier date, and a non-Active training; nothing is recorded', async () => {
    const planned = addDays(today(), 10);
    const { hr, id } = await activeTraining(addDays(today(), -20), planned);
    // A blank or missing reason is refused by the request validation (like [Required]), before any rule runs.
    for (const payload of [{ endDate: addDays(planned, 5), reason: '   ' }, { endDate: addDays(planned, 5) }]) {
      const refused = await extend(hr.client, id, payload);
      expect(refused.status).toBe(400);
      expect((await body<{ errors: Record<string, string[]> }>(refused)).errors).toEqual({
        Reason: ['The Reason field is required.'],
      });
    }
    for (const [payload, expected] of [
      [{ endDate: planned, reason: 'x' }, 'assignment.extension_not_later'],
      [{ endDate: addDays(planned, -1), reason: 'x' }, 'assignment.extension_not_later'],
      [{ endDate: 'not-a-date', reason: 'x' }, 'validation.required'],
    ] as const) {
      const refused = await extend(hr.client, id, payload);
      expect(refused.status, JSON.stringify(payload)).toBe(400);
      expect((await body(refused)).code).toBe(expected);
    }
    expect(await history(id)).toEqual([]);
    expect(await endDate(id)).toBe(planned);

    // Ended (Phase 1): cannot be extended.
    expect(
      (await hr.client.post(`/api/hr/assignments/${id}/withdraw`, { endDate: today(), reason: 'Left' })).status,
    ).toBe(200);
    const ended = await extend(hr.client, id, { endDate: addDays(today(), 30), reason: 'x' });
    expect(ended.status).toBe(400);
    expect((await body(ended)).code).toBe('assignment.invalid_status');
    expect(await history(id)).toEqual([]);
    expect((await extend(hr.client, crypto.randomUUID(), { endDate: today(), reason: 'x' })).status).toBe(404);
  });

  it('concurrent extensions: exactly one applies; every other one is rolled back with its history row (atomicity)', async () => {
    const planned = addDays(today(), 10);
    const { hr, id } = await activeTraining(addDays(today(), -20), planned);
    const hr2 = await signInStaff(api, 'HR');
    const dates = [20, 30, 40, 50].map((d) => addDays(today(), d));
    const results = await Promise.all(
      dates.map((d, i) => extend(i % 2 ? hr2.client : hr.client, id, { endDate: d, reason: `Reason ${i}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    for (const s of statuses.filter((s) => s !== 200)) expect([400, 409]).toContain(s);
    // Losers that read before the winner committed inserted a history row, then lost the version check: rolled back.
    const rows = await history(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.previous_end_date).toBe(planned);
    expect(await endDate(id)).toBe(rows[0]!.new_end_date);
  });

  it('only HR may extend; the reasons are visible to HR only; other roles and signed-out callers are refused', async () => {
    const { admin, employee, trainee, hr, id } = await activeTraining(addDays(today(), -20), addDays(today(), 10));
    const reason = `Private extension reason ${crypto.randomUUID()}`;
    expect((await extend(hr.client, id, { endDate: addDays(today(), 30), reason })).status).toBe(200);
    for (const [name, client] of [
      ['Admin', admin.client],
      ['Employee', employee.client],
      ['Trainee', trainee.client],
    ] as const) {
      expect((await extend(client, id, { endDate: addDays(today(), 60), reason: 'x' })).status, name).toBe(403);
      expect((await client.get('/api/hr/assignments')).status, name).toBe(403);
    }
    expect((await extend(api.client(), id, { endDate: addDays(today(), 60), reason: 'x' })).status).toBe(401);
    for (const [url, client] of [
      ['/api/employee/trainees', employee.client],
      ['/api/trainee/applications', trainee.client],
      [`/api/admin/reports/monthly?month=${today().slice(0, 7)}`, admin.client],
    ] as const) {
      const response = await client.get(url);
      expect(response.status, url).toBe(200);
      expect(await response.text(), url).not.toContain(reason);
    }
    expect(
      (await body<Assignment[]>(await hr.client.get('/api/hr/assignments'))).find((a) => a.id === id)?.extensions[0]
        ?.reason,
    ).toBe(reason);
  });

  it('Phase 1 still works after an extension: the extended date is the planned end date for Completed / Ended early', async () => {
    const { hr, id } = await activeTraining(addDays(today(), -40), addDays(today(), -10));
    expect((await extend(hr.client, id, { endDate: addDays(today(), 20), reason: 'More work' })).status).toBe(200);
    // Before the extended planned end date: a successful completion is Ended early and needs a reason.
    const early = await hr.client.post(`/api/hr/assignments/${id}/complete`, { endDate: today() });
    expect(early.status).toBe(400);
    expect((await body(early)).code).toBe('validation.required');
    const done = await hr.client.post(`/api/hr/assignments/${id}/complete`, {
      endDate: today(),
      reason: 'Done sooner',
    });
    expect(await body<Assignment>(done)).toMatchObject({ status: 'EndedEarly', endDate: today() });
    expect(await history(id)).toHaveLength(1); // the extension stays on record after the ending
  });
});
