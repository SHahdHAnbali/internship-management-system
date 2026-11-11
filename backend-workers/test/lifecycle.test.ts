import { describe, expect, it } from 'vitest';
import { calendarDate, endAssignment } from '../src/domain/training';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Training lifecycle Phase 1 (AD-63, owner decisions 2026-11-11): HR ends an Active training as Completed, EndedEarly
 * or Withdrawn with an actual end date chosen by HR (never before the start, never after today's Asia/Hebron date);
 * the date replaces the planned end date; reasons for EndedEarly and Withdrawn. Real endpoints, real database as
 * `ims_app` (column-level UPDATE on status, end_date, end_reason only).
 */
const api = createTestApi();

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => calendarDate(new Date());

interface Assignment {
  id: string;
  status: string;
  startDate: string;
  endDate: string;
  endReason: string | null;
}

/** HR, an employee and an Active assignment with the given dates (accepted through the API, assigned as a fixture). */
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

const end = (client: TestClient, id: string, action: 'complete' | 'withdraw', payload: unknown) =>
  client.post(`/api/hr/assignments/${id}/${action}`, payload);

const stored = (id: string) =>
  withDb((db) =>
    db.query<{ status: string; end_date: string; end_reason: string | null }>(
      'SELECT status, end_date::text, end_reason FROM assignments WHERE id = $1',
      [id],
    ),
  ).then((r) => r.rows[0]!);

const updates = (id: string) =>
  withDb((db) =>
    db.query<{ actor_type: string; actor_id: string; old_values: object; new_values: object }>(
      `SELECT actor_type, actor_id, old_values, new_values FROM audit_logs
        WHERE table_name = 'assignments' AND entity_id = $1 AND operation = 'UPDATE' ORDER BY id`,
      [id],
    ),
  ).then((r) => r.rows);

describe('the official calendar day (Asia/Hebron)', () => {
  it('turns an instant into the Asia/Hebron date, winter (UTC+2) and summer (UTC+3)', () => {
    expect(calendarDate(new Date('2026-11-10T21:59:00Z'))).toBe('2026-11-10');
    expect(calendarDate(new Date('2026-11-10T22:00:00Z'))).toBe('2026-11-11');
    expect(calendarDate(new Date('2026-07-01T20:59:00Z'))).toBe('2026-07-01');
    expect(calendarDate(new Date('2026-07-01T21:00:00Z'))).toBe('2026-07-02');
  });
});

describe('endAssignment (AD-63 rules)', () => {
  const active = { status: 'Active', startDate: '2026-09-01', plannedEndDate: '2026-11-01' };
  const T = '2026-11-11';
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return 'no error';
  };

  it('completion: Completed on or after the planned end date (no reason), EndedEarly before it (reason required)', () => {
    expect(endAssignment('completion', { endDate: '2026-11-01', reason: null }, active, T)).toEqual({
      status: 'Completed',
      endDate: '2026-11-01',
      reason: null,
    });
    expect(endAssignment('completion', { endDate: T, reason: '' }, active, T).status).toBe('Completed');
    expect(code(() => endAssignment('completion', { endDate: '2026-11-02', reason: 'x' }, active, T))).toBe(
      'assignment.reason_not_applicable',
    );
    expect(endAssignment('completion', { endDate: '2026-10-31', reason: ' Done early ' }, active, T)).toEqual({
      status: 'EndedEarly',
      endDate: '2026-10-31',
      reason: 'Done early',
    });
    expect(code(() => endAssignment('completion', { endDate: '2026-10-31', reason: '  ' }, active, T))).toBe(
      'validation.required',
    );
  });

  it('withdrawal: any date from the start to today, reason required', () => {
    expect(endAssignment('withdrawal', { endDate: '2026-09-01', reason: 'Left' }, active, T)).toEqual({
      status: 'Withdrawn',
      endDate: '2026-09-01',
      reason: 'Left',
    });
    expect(code(() => endAssignment('withdrawal', { endDate: '2026-10-01', reason: null }, active, T))).toBe(
      'validation.required',
    );
  });

  it('dates: never before the start, never after today; a valid date is required; only Active can end', () => {
    expect(code(() => endAssignment('withdrawal', { endDate: '2026-08-31', reason: 'x' }, active, T))).toBe(
      'assignment.end_before_start',
    );
    expect(code(() => endAssignment('completion', { endDate: '2026-11-12', reason: null }, active, T))).toBe(
      'assignment.end_in_future',
    );
    expect(endAssignment('completion', { endDate: T, reason: null }, active, T).endDate).toBe(T);
    for (const bad of [null, '', '2026-13-01', '11/11/2026'])
      expect(code(() => endAssignment('completion', { endDate: bad, reason: null }, active, T))).toBe(
        'validation.required',
      );
    for (const status of ['Completed', 'EndedEarly', 'Withdrawn', 'Transferred'])
      expect(code(() => endAssignment('withdrawal', { endDate: T, reason: 'x' }, { ...active, status }, T))).toBe(
        'assignment.invalid_status',
      );
  });
});

describe('HR ends a training (API)', () => {
  it('normal completion on the planned end date: Completed, no reason, the date kept, audited with HR as actor', async () => {
    const planned = addDays(today(), -1);
    const { hr, id } = await activeTraining(addDays(today(), -60), planned);
    const response = await end(hr.client, id, 'complete', { endDate: planned });
    expect(response.status).toBe(200);
    expect(await body<Assignment>(response)).toMatchObject({
      id,
      status: 'Completed',
      endDate: planned,
      endReason: null,
    });
    expect(await stored(id)).toEqual({ status: 'Completed', end_date: planned, end_reason: null });
    expect(await updates(id)).toEqual([
      {
        actor_type: 'Staff',
        actor_id: hr.user.id,
        old_values: { status: 'Active' },
        new_values: { status: 'Completed' },
      },
    ]);
  });

  it('completion after the planned end date: Completed, and the actual date replaces the planned one (old value audited)', async () => {
    const planned = addDays(today(), -10);
    const { hr, id } = await activeTraining(addDays(today(), -60), planned);
    const actual = addDays(today(), -3);
    expect((await end(hr.client, id, 'complete', { endDate: actual })).status).toBe(200);
    expect(await stored(id)).toEqual({ status: 'Completed', end_date: actual, end_reason: null });
    const [update] = await updates(id);
    expect(update!.old_values).toEqual({ status: 'Active', end_date: planned });
    expect(update!.new_values).toEqual({ status: 'Completed', end_date: actual });

    // A reason is not taken for a normal completion.
    const other = await activeTraining(addDays(today(), -60), addDays(today(), -10));
    const withReason = await end(other.hr.client, other.id, 'complete', { endDate: today(), reason: 'Not needed' });
    expect(withReason.status).toBe(400);
    expect((await body(withReason)).code).toBe('assignment.reason_not_applicable');
  });

  it('early completion: EndedEarly with the mandatory reason; the planned date is replaced and audited', async () => {
    const planned = addDays(today(), 30);
    const { hr, id } = await activeTraining(addDays(today(), -30), planned);
    const missing = await end(hr.client, id, 'complete', { endDate: today() });
    expect(missing.status).toBe(400);
    expect((await body(missing)).code).toBe('validation.required');
    expect((await stored(id)).status).toBe('Active');

    const reason = 'المشروع اكتمل مبكراً / Project finished early <b>!</b>';
    const response = await end(hr.client, id, 'complete', { endDate: today(), reason });
    expect(response.status).toBe(200);
    expect(await body<Assignment>(response)).toMatchObject({
      status: 'EndedEarly',
      endDate: today(),
      endReason: reason,
    });
    const [update] = await updates(id);
    expect(update!.old_values).toEqual({ status: 'Active', end_date: planned, end_reason: null });
    expect(update!.new_values).toEqual({ status: 'EndedEarly', end_date: today(), end_reason: reason });
  });

  it('withdrawal: Withdrawn with the mandatory reason, from the start date; before the start and in the future refused', async () => {
    const start = addDays(today(), -20);
    const { hr, id } = await activeTraining(start, addDays(today(), 40));
    for (const [payload, code] of [
      [{ endDate: today() }, 'validation.required'],
      [{ endDate: addDays(start, -1), reason: 'Left' }, 'assignment.end_before_start'],
      [{ endDate: addDays(today(), 1), reason: 'Left' }, 'assignment.end_in_future'],
      [{ endDate: 'not-a-date', reason: 'Left' }, 'validation.required'],
    ] as const) {
      const refused = await end(hr.client, id, 'withdraw', payload);
      expect(refused.status, JSON.stringify(payload)).toBe(400);
      expect((await body(refused)).code).toBe(code);
    }
    expect(await updates(id)).toEqual([]); // nothing changed by a refused request

    const response = await end(hr.client, id, 'withdraw', { endDate: start, reason: 'Moved to another city' });
    expect(response.status).toBe(200);
    expect(await stored(id)).toEqual({ status: 'Withdrawn', end_date: start, end_reason: 'Moved to another city' });
  });

  it('a training that has not started cannot be ended (no date is both on or after the start and not in the future)', async () => {
    const { hr, id } = await activeTraining(addDays(today(), 5), addDays(today(), 60));
    const response = await end(hr.client, id, 'withdraw', { endDate: today(), reason: 'Left' });
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe('assignment.end_before_start');
  });

  it('only an Active training can be ended; an ended one stays as it is', async () => {
    const { hr, id } = await activeTraining(addDays(today(), -60), addDays(today(), -1));
    expect((await end(hr.client, id, 'complete', { endDate: today() })).status).toBe(200);
    for (const [action, payload] of [
      ['complete', { endDate: today() }],
      ['withdraw', { endDate: today(), reason: 'x' }],
    ] as const) {
      const again = await end(hr.client, id, action, payload);
      expect(again.status).toBe(400);
      expect((await body(again)).code).toBe('assignment.invalid_status');
    }
    expect(await updates(id)).toHaveLength(1);
    expect((await end(hr.client, crypto.randomUUID(), 'complete', { endDate: today() })).status).toBe(404);
  });

  it('two HR decisions at the same moment: exactly one is applied and audited once', async () => {
    const { hr, id } = await activeTraining(addDays(today(), -60), addDays(today(), -1));
    const hr2 = await signInStaff(api, 'HR');
    const results = await Promise.all([
      end(hr.client, id, 'complete', { endDate: today() }),
      end(hr2.client, id, 'withdraw', { endDate: today(), reason: 'Left' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]); // 409: changed meanwhile; 400: read after the winner committed
    expect(await updates(id)).toHaveLength(1);
  });

  it('only HR may end a training or list trainings; signed-out callers are refused', async () => {
    const { admin, employee, trainee, id } = await activeTraining(addDays(today(), -60), addDays(today(), -1));
    for (const [name, client] of [
      ['Admin', admin.client],
      ['Employee', employee.client],
      ['Trainee', trainee.client],
    ] as const) {
      expect((await end(client, id, 'complete', { endDate: today() })).status, name).toBe(403);
      expect((await end(client, id, 'withdraw', { endDate: today(), reason: 'x' })).status, name).toBe(403);
      expect((await client.get('/api/hr/assignments')).status, name).toBe(403);
    }
    expect((await end(api.client(), id, 'complete', { endDate: today() })).status).toBe(401);
    expect((await stored(id)).status).toBe('Active');
  });

  it('the HR trainings list shows the new status, the actual end date and the reason; other roles never see the reason', async () => {
    const { hr, employee, id } = await activeTraining(addDays(today(), -30), addDays(today(), 30));
    const reason = `Private reason ${crypto.randomUUID()}`;
    expect((await end(hr.client, id, 'withdraw', { endDate: today(), reason })).status).toBe(200);

    const list = await body<Assignment[]>(await hr.client.get('/api/hr/assignments'));
    expect(list.find((a) => a.id === id)).toMatchObject({ status: 'Withdrawn', endDate: today(), endReason: reason });

    // The employee keeps their trainee and notes view, without the reason; notes stay read-only after the ending.
    const mine = await employee.client.get('/api/employee/trainees');
    expect(mine.status).toBe(200);
    expect(await mine.text()).not.toContain(reason);
    const note = await employee.client.post(`/api/employee/assignments/${id}/notes`, { text: 'After the end' });
    expect(note.status).toBe(400);
  });

  it('the monthly report uses the actual end date after an ending', async () => {
    const { hr, id } = await activeTraining(addDays(today(), -30), addDays(today(), 400));
    expect((await end(hr.client, id, 'withdraw', { endDate: today(), reason: 'Left' })).status).toBe(200);
    const month = today().slice(0, 7);
    const report = await body<{ rows: { assignmentId: string; endDate: string }[] }>(
      await hr.client.get(`/api/hr/reports/monthly?month=${month}`),
    );
    expect(report.rows.find((r) => r.assignmentId === id)?.endDate).toBe(today());
  });
});
