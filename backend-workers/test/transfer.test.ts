import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Bindings } from '../src/config';
import { Database, type AuditActor, type Queryable } from '../src/db';
import { calendarDate, decideTransfer, previousDay, transferExecution } from '../src/domain/training';
import { executeDueTransfers, type TransactionalDatabase } from '../src/features/training/transfers';
import { createScheduledHandler } from '../src/scheduled';
import { body, createTestApi, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Trainee transfer (AD-65, owner decisions 2026-11-13, revised): only the application's current responsible HR (AD-64)
 * decides to transfer an Active training to another mentor who holds the Employee role now, without their approval. The
 * effective date (Asia/Hebron) is today (executed at once) or later (Pending, executed by the scheduled job on that date),
 * never earlier; after the start date and not after the planned end date. On execution the outgoing assignment becomes
 * Transferred and ends the day before, the incoming one starts on the date with the planned end date as it is then; the
 * decision and the link are kept. One pending transfer per training; the current responsible HR cancels it with a reason.
 * The latest mentor reads the earlier mentors' notes. No notification, no evaluation.
 */
const ENABLED: Partial<Bindings> = { EVENT_EMAILS: 'enabled' };
const api = createTestApi({}, ENABLED);
const DAY = 86_400_000;

beforeEach(() => {
  api.clock.offsetMs = 0;
});

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => calendarDate(new Date());

/** The instant a calendar day starts in Asia/Hebron (22:00 UTC the day before in winter, 21:00 in summer). */
function hebronMidnight(date: string): Date {
  const before = addDays(date, -1);
  for (let hour = 18; hour <= 23; hour++) {
    const at = new Date(`${before}T${String(hour).padStart(2, '0')}:00:00Z`);
    if (calendarDate(at) === date && calendarDate(new Date(at.getTime() - 1)) === before) return at;
  }
  throw new Error(`No Asia/Hebron midnight found for ${date}`);
}

interface Decision {
  id: string;
  status: string;
  effectiveDate: string;
  incomingEmployeeName: string;
  reason: string;
  decidedBy: string;
  resolvedBy: string | null;
  resolutionCode: string | null;
  resolutionReason: string | null;
}

interface Assignment {
  id: string;
  applicationId: string;
  status: string;
  startDate: string;
  endDate: string;
  endReason: string | null;
  employee: { id: string };
  canTransfer: boolean;
  canCancelTransfer: boolean;
  transferDecisions: Decision[];
  transferredFrom: { assignmentId: string; employeeName: string } | null;
  transferredTo: { assignmentId: string; employeeName: string } | null;
}

/** A training accepted by HR A (its responsible HR), Active with mentor A from `start` to `end`. */
async function training(testApi: TestApi, start: string, end: string) {
  const admin = await signInStaff(testApi, 'Admin');
  const hrA = await signInStaff(testApi, 'HR');
  const hrB = await signInStaff(testApi, 'HR');
  const mentorA = await signInStaff(testApi, 'Employee');
  const mentorB = await signInStaff(testApi, 'Employee');
  const mentorC = await signInStaff(testApi, 'Employee');
  const trainee = await signInTrainee(testApi);
  const field = await newField(admin.client);
  const applicationId = await submitApplication(trainee.client, field.id);
  expect((await hrA.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  const id = await seedAssignment(applicationId, mentorA.user.id, start, end, 'Active');
  return { admin, hrA, hrB, mentorA, mentorB, mentorC, trainee, applicationId, id };
}

const transfer = (client: TestClient, id: string, payload: object) =>
  client.post(`/api/hr/assignments/${id}/transfer`, payload);
const cancel = (client: TestClient, decisionId: string, payload: object) =>
  client.post(`/api/hr/transfer-decisions/${decisionId}/cancel`, payload);
const note = (client: TestClient, id: string, text: string) =>
  client.post(`/api/employee/assignments/${id}/notes`, { text });

const assignments = (applicationId: string) =>
  withDb((db) =>
    db.query<{
      id: string;
      employee_id: string;
      status: string;
      start: string;
      end: string;
      end_reason: string | null;
    }>(
      `SELECT id, employee_id, status, start_date::text AS start, end_date::text AS end, end_reason
         FROM assignments WHERE application_id = $1 ORDER BY start_date, created_at`,
      [applicationId],
    ),
  ).then((r) => r.rows);

const links = (applicationId: string) =>
  withDb((db) =>
    db.query<{
      decision_id: string;
      from_assignment_id: string;
      to_assignment_id: string;
      transferred_by_id: string;
      transferred_at: Date;
    }>(
      `SELECT x.decision_id, x.from_assignment_id, x.to_assignment_id, x.transferred_by_id, x.transferred_at
         FROM assignment_transfers x JOIN assignments s ON s.id = x.from_assignment_id
        WHERE s.application_id = $1 ORDER BY x.transferred_at, x.id`,
      [applicationId],
    ),
  ).then((r) => r.rows);

const decisions = (applicationId: string) =>
  withDb((db) =>
    db.query<{
      id: string;
      status: string;
      effective: string;
      decided_by_id: string;
      resolved_by_id: string | null;
      resolution_code: string | null;
      resolution_reason: string | null;
      resolved: boolean;
    }>(
      `SELECT id, status, effective_date::text AS effective, decided_by_id, resolved_by_id, resolution_code,
              resolution_reason, resolved_at IS NOT NULL AS resolved
         FROM transfer_decisions WHERE application_id = $1 ORDER BY decided_at, id`,
      [applicationId],
    ),
  ).then((r) => r.rows);

/** The audit rows written in the transaction that wrote `entityId` of `table` (by its first such row). */
const auditOfTransaction = (table: string, entityId: string, operation = 'INSERT') =>
  withDb((db) =>
    db.query<{ table_name: string; operation: string; actor_type: string; actor_id: string | null }>(
      `SELECT table_name, operation, actor_type, actor_id FROM audit_logs
        WHERE transaction_id = (SELECT l.transaction_id FROM audit_logs l
                                 WHERE l.table_name = $1 AND l.entity_id = $2 AND l.operation = $3
                                 ORDER BY l.id LIMIT 1)
        ORDER BY id`,
      [table, entityId, operation],
    ),
  ).then((r) => r.rows);

const hrList = async (client: TestClient) => body<Assignment[]>(await client.get('/api/hr/assignments'));
const hrRow = async (client: TestClient, id: string) => (await hrList(client)).find((a) => a.id === id);

/** One run of the scheduled job as the Worker does it (as `ims_app`), at `now`. */
async function runJob(now: Date, wrap: (db: Database) => TransactionalDatabase = (db) => db) {
  const db = new Database((env as unknown as Bindings).DATABASE_URL!);
  try {
    return await executeDueTransfers(wrap(db), now);
  } finally {
    await db.close();
  }
}

/** Notifications of these users other than new-application ones (which other test files create at the same time). */
const notificationCount = (ids: string[]) =>
  withDb((db) =>
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE recipient_id = ANY($1::uuid[]) AND type <> 'ApplicationSubmitted'`,
      [ids],
    ),
  ).then((r) => r.rows[0]!.n);

describe('decideTransfer and transferExecution (AD-65 rules)', () => {
  const active = { status: 'Active', startDate: '2027-01-03', plannedEndDate: '2027-03-31', employeeId: 'a' };
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return 'no error';
  };
  const input = (transferDate: string, employeeId: string | null = 'b', reason: string | null = 'Moved') => ({
    employeeId,
    transferDate,
    reason,
  });

  it('accepts today or a later date; refuses past dates and every other invalid case', () => {
    expect(decideTransfer(input('2027-02-15', 'b', ' New project '), active, '2027-02-15')).toEqual({
      incomingEmployeeId: 'b',
      effectiveDate: '2027-02-15',
      reason: 'New project',
    });
    expect(decideTransfer(input('2027-03-31'), active, '2027-02-15').effectiveDate).toBe('2027-03-31');
    expect(previousDay('2027-03-01')).toBe('2027-02-28');
    for (const [args, expected] of [
      [[input('2027-02-14'), active, '2027-02-15'], 'assignment.transfer_in_past'],
      [[input('2027-01-03'), active, '2027-01-03'], 'assignment.transfer_not_after_start'], // first day
      [[input('2027-01-02'), active, '2027-01-01'], 'assignment.transfer_not_after_start'],
      [[input('2027-04-01'), active, '2027-02-15'], 'assignment.transfer_after_end'],
      [[input('2027-02-20', 'a'), active, '2027-02-15'], 'assignment.transfer_same_mentor'],
      [[input('2027-02-20', null), active, '2027-02-15'], 'validation.required'],
      [[input('soon'), active, '2027-02-15'], 'validation.required'],
      [[input('2027-02-20', 'b', '  '), active, '2027-02-15'], 'validation.required'],
      [[input('2027-02-20'), { ...active, status: 'Completed' }, '2027-02-15'], 'assignment.invalid_status'],
    ] as const) {
      expect(
        code(() => decideTransfer(...(args as unknown as Parameters<typeof decideTransfer>))),
        expected,
      ).toBe(expected);
    }
  });

  it('on execution: T-1 / T with the planned end date as it is then; the same rules are checked again', () => {
    const decision = { incomingEmployeeId: 'b', effectiveDate: '2027-03-01' };
    expect(transferExecution(decision, { ...active, plannedEndDate: '2027-05-31' })).toEqual({
      outgoingEndDate: '2027-02-28',
      plannedEndDate: '2027-05-31',
    });
    expect(code(() => transferExecution(decision, { ...active, status: 'Withdrawn' }))).toBe(
      'assignment.invalid_status',
    );
    expect(code(() => transferExecution(decision, { ...active, plannedEndDate: '2027-02-27' }))).toBe(
      'assignment.transfer_after_end',
    );
  });
});

describe('HR decides a transfer (API)', () => {
  it('today: executed at once, T-1 / T, same planned end, decision and link kept, audited as HR, no notification', async () => {
    const start = addDays(today(), -30);
    const end = addDays(today(), 30);
    const t = await training(api, start, end);
    const sentBefore = api.emails.sent.length;
    const users = [t.hrA.user.id, t.hrB.user.id, t.mentorA.user.id, t.mentorB.user.id];
    const notificationsBefore = await notificationCount(users);

    const response = await transfer(t.hrA.client, t.id, {
      employeeId: t.mentorB.user.id,
      transferDate: today(),
      reason: 'نقل إلى فريق آخر / Moved to another team',
    });
    expect(response.status).toBe(200);
    const incoming = await body<Assignment>(response);
    expect(incoming).toMatchObject({
      status: 'Active',
      startDate: today(),
      endDate: end,
      employee: { id: t.mentorB.user.id },
      canTransfer: true,
      canCancelTransfer: false,
      transferDecisions: [],
      transferredFrom: { assignmentId: t.id, employeeName: expect.any(String) },
      transferredTo: null,
    });

    expect(await assignments(t.applicationId)).toEqual([
      {
        id: t.id,
        employee_id: t.mentorA.user.id,
        status: 'Transferred',
        start,
        end: addDays(today(), -1),
        end_reason: 'نقل إلى فريق آخر / Moved to another team',
      },
      { id: incoming.id, employee_id: t.mentorB.user.id, status: 'Active', start: today(), end, end_reason: null },
    ]);
    const [decision] = await decisions(t.applicationId);
    expect(decision).toMatchObject({
      status: 'Executed',
      effective: today(),
      decided_by_id: t.hrA.user.id,
      resolved_by_id: null,
      resolved: true,
    });
    expect(await links(t.applicationId)).toMatchObject([
      {
        decision_id: decision!.id,
        from_assignment_id: t.id,
        to_assignment_id: incoming.id,
        transferred_by_id: t.hrA.user.id,
      },
    ]);

    // One transaction, audited with HR A as the actor, and it wrote nothing else (no notification, no evaluation).
    const actor = { actor_type: 'Staff', actor_id: t.hrA.user.id };
    expect(await auditOfTransaction('transfer_decisions', decision!.id)).toEqual([
      { table_name: 'transfer_decisions', operation: 'INSERT', ...actor },
      { table_name: 'assignments', operation: 'UPDATE', ...actor },
      { table_name: 'assignments', operation: 'INSERT', ...actor },
      { table_name: 'assignment_transfers', operation: 'INSERT', ...actor },
      { table_name: 'transfer_decisions', operation: 'UPDATE', ...actor },
    ]);
    expect(api.emails.sent.length).toBe(sentBefore);
    expect(await notificationCount(users)).toBe(notificationsBefore);

    // The HR list: the outgoing row links forward and shows its executed decision.
    expect(await hrRow(t.hrA.client, t.id)).toMatchObject({
      status: 'Transferred',
      canTransfer: false,
      canCancelTransfer: false,
      transferredTo: { assignmentId: incoming.id },
      transferDecisions: [{ status: 'Executed', effectiveDate: today(), resolutionCode: null }],
    });
    expect((await hrRow(t.hrB.client, incoming.id))?.canTransfer).toBe(false);

    // AD-64 unchanged: the responsible HR is still HR A, from the acceptance; nothing recorded in responsible_hr_changes.
    const responsibility = await withDb((db) =>
      db.query(
        `SELECT a.decided_by_id, (SELECT count(*)::int FROM responsible_hr_changes r WHERE r.application_id = a.id) AS changes
           FROM training_applications a WHERE a.id = $1`,
        [t.applicationId],
      ),
    );
    expect(responsibility.rows).toEqual([{ decided_by_id: t.hrA.user.id, changes: 0 }]);
  });

  it('a later date: Pending only; the outgoing mentor stays responsible and the incoming one has no access yet', async () => {
    const end = addDays(today(), 30);
    const t = await training(api, addDays(today(), -10), end);
    const effective = addDays(today(), 3);
    const response = await transfer(t.hrA.client, t.id, {
      employeeId: t.mentorB.user.id,
      transferDate: effective,
      reason: 'Later',
    });
    expect(response.status).toBe(200);
    expect(await body<Assignment>(response)).toMatchObject({
      id: t.id,
      status: 'Active',
      endDate: end,
      employee: { id: t.mentorA.user.id },
      canTransfer: false,
      canCancelTransfer: true,
      transferredTo: null,
      transferDecisions: [
        { status: 'Pending', effectiveDate: effective, reason: 'Later', resolvedBy: null, resolutionCode: null },
      ],
    });
    expect((await hrRow(t.hrB.client, t.id))?.canCancelTransfer).toBe(false); // not the responsible HR
    expect((await assignments(t.applicationId)).map((a) => [a.employee_id, a.status])).toEqual([
      [t.mentorA.user.id, 'Active'],
    ]);
    expect(await links(t.applicationId)).toEqual([]);
    expect(await auditOfTransaction('transfer_decisions', (await decisions(t.applicationId))[0]!.id)).toEqual([
      { table_name: 'transfer_decisions', operation: 'INSERT', actor_type: 'Staff', actor_id: t.hrA.user.id },
    ]);

    // Mentor A keeps the training (notes included); mentor B sees nothing of it yet.
    expect((await note(t.mentorA.client, t.id, 'Still mine')).status).toBe(201);
    const bTrainees = await body<{ id: string }[]>(await t.mentorB.client.get('/api/employee/trainees'));
    expect(bTrainees.find((a) => a.id === t.id)).toBeUndefined();
    expect((await t.mentorB.client.get(`/api/employee/assignments/${t.id}/notes`)).status).toBe(404);

    // The scheduled job does not execute it before its date.
    await runJob(new Date());
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Pending']);
  });

  it('only the current responsible HR: other HR 403; Admin, Employee, Trainee refused; signed out 401', async () => {
    const t = await training(api, addDays(today(), -30), addDays(today(), 30));
    const payload = { employeeId: t.mentorB.user.id, transferDate: addDays(today(), 2), reason: 'Moved' };
    const otherHr = await transfer(t.hrB.client, t.id, payload);
    expect(otherHr.status).toBe(403);
    expect((await body(otherHr)).code).toBe('assignment.transfer_not_responsible');
    for (const [name, client] of [
      ['Admin', t.admin.client],
      ['Employee', t.mentorA.client],
      ['Trainee', t.trainee.client],
    ] as const) {
      expect((await transfer(client, t.id, payload)).status, name).toBe(403);
      expect((await client.get('/api/hr/mentors')).status, name).toBe(403);
    }
    expect((await transfer(api.client(), t.id, payload)).status).toBe(401);
    expect(await decisions(t.applicationId)).toEqual([]);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Active']);
  });

  it('refuses a past date, an invalid mentor, date or reason, and a training that is not Active; nothing is written', async () => {
    const t = await training(api, addDays(today(), -30), addDays(today(), 30));
    const ok = { employeeId: t.mentorB.user.id, transferDate: addDays(today(), 2), reason: 'Moved' };
    for (const [payload, expected] of [
      [{ ...ok, transferDate: addDays(today(), -1) }, 'assignment.transfer_in_past'],
      [{ ...ok, transferDate: addDays(today(), -10) }, 'assignment.transfer_in_past'],
      [{ ...ok, employeeId: t.mentorA.user.id }, 'assignment.transfer_same_mentor'],
      [{ ...ok, employeeId: t.hrB.user.id }, 'assignment.transfer_mentor_not_employee'],
      [{ ...ok, employeeId: t.admin.user.id }, 'assignment.transfer_mentor_not_employee'],
      [{ ...ok, employeeId: crypto.randomUUID() }, 'assignment.transfer_mentor_not_employee'],
      [{ ...ok, employeeId: 'not-a-guid' }, 'validation.required'],
      [{ ...ok, transferDate: addDays(today(), 31) }, 'assignment.transfer_after_end'],
      [{ ...ok, transferDate: 'soon' }, 'validation.required'],
    ] as const) {
      const refused = await transfer(t.hrA.client, t.id, payload);
      expect(refused.status, JSON.stringify(payload)).toBe(400);
      expect((await body(refused)).code, JSON.stringify(payload)).toBe(expected);
    }
    for (const payload of [
      { ...ok, reason: '   ' },
      { employeeId: ok.employeeId, transferDate: ok.transferDate },
    ]) {
      const refused = await transfer(t.hrA.client, t.id, payload);
      expect(refused.status).toBe(400);
      expect((await body<{ errors: Record<string, string[]> }>(refused)).errors).toEqual({
        Reason: ['The Reason field is required.'],
      });
    }
    expect((await transfer(t.hrA.client, crypto.randomUUID(), ok)).status).toBe(404);
    expect(await decisions(t.applicationId)).toEqual([]);

    // A training that starts later: its first day is refused (the outgoing assignment would end before it starts).
    const upcoming = await training(api, addDays(today(), 2), addDays(today(), 30));
    const firstDay = await transfer(upcoming.hrA.client, upcoming.id, {
      employeeId: upcoming.mentorB.user.id,
      transferDate: addDays(today(), 2),
      reason: 'Moved',
    });
    expect((await body(firstDay)).code).toBe('assignment.transfer_not_after_start');

    // After the planned end date (an overdue Active training): refused until extended.
    const late = await training(api, addDays(today(), -60), addDays(today(), -20));
    const afterEnd = await transfer(late.hrA.client, late.id, {
      employeeId: late.mentorB.user.id,
      transferDate: today(),
      reason: 'Moved',
    });
    expect((await body(afterEnd)).code).toBe('assignment.transfer_after_end');

    // An ended training cannot be transferred.
    expect(
      (await t.hrA.client.post(`/api/hr/assignments/${t.id}/withdraw`, { endDate: today(), reason: 'Left' })).status,
    ).toBe(200);
    const ended = await transfer(t.hrA.client, t.id, ok);
    expect((await body(ended)).code).toBe('assignment.invalid_status');
    expect(await decisions(t.applicationId)).toEqual([]);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Withdrawn']);
  });

  it('one pending transfer per training: another decision is refused (409), also under concurrency', async () => {
    const t = await training(api, addDays(today(), -30), addDays(today(), 30));
    const first = await transfer(t.hrA.client, t.id, {
      employeeId: t.mentorB.user.id,
      transferDate: addDays(today(), 5),
      reason: 'First',
    });
    expect(first.status).toBe(200);
    for (const transferDate of [addDays(today(), 7), today()]) {
      const second = await transfer(t.hrA.client, t.id, {
        employeeId: t.mentorC.user.id,
        transferDate,
        reason: 'Second',
      });
      expect(second.status, transferDate).toBe(409);
      expect((await body(second)).code).toBe('assignment.transfer_pending');
    }
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Pending']);

    // Concurrent decisions on another training: exactly one is recorded.
    const u = await training(api, addDays(today(), -30), addDays(today(), 30));
    const later = await Promise.all(
      [u.mentorB, u.mentorC, u.mentorB, u.mentorC].map((m, i) =>
        transfer(u.hrA.client, u.id, { employeeId: m.user.id, transferDate: addDays(today(), 3 + i), reason: `R${i}` }),
      ),
    );
    expect(later.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of later.filter((r) => r.status !== 200)) expect(r.status).toBe(409);
    expect((await decisions(u.applicationId)).map((d) => d.status)).toEqual(['Pending']);

    // Concurrent immediate transfers on a third: exactly one applies, never two Active assignments (atomic).
    const v = await training(api, addDays(today(), -30), addDays(today(), 30));
    const now = await Promise.all(
      [v.mentorB, v.mentorC, v.mentorB, v.mentorC].map((m, i) =>
        transfer(v.hrA.client, v.id, { employeeId: m.user.id, transferDate: today(), reason: `R${i}` }),
      ),
    );
    expect(now.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of now.filter((r) => r.status !== 200)) expect([400, 409]).toContain(r.status);
    const rows = await assignments(v.applicationId);
    expect(rows.map((a) => a.status)).toEqual(['Transferred', 'Active']);
    expect(await links(v.applicationId)).toHaveLength(1);
    expect((await decisions(v.applicationId)).map((d) => d.status)).toEqual(['Executed']);
  });

  it('the current responsible HR cancels with a reason; the decision is kept; rescheduling is a new decision', async () => {
    const t = await training(api, addDays(today(), -30), addDays(today(), 30));
    const scheduled = await body<Assignment>(
      await transfer(t.hrA.client, t.id, {
        employeeId: t.mentorB.user.id,
        transferDate: addDays(today(), 2),
        reason: 'Plan',
      }),
    );
    const decisionId = scheduled.transferDecisions[0]!.id;

    // Who may cancel: the current responsible HR only.
    expect((await body(await cancel(t.hrB.client, decisionId, { reason: 'x' }))).code).toBe(
      'assignment.transfer_not_responsible',
    );
    for (const client of [t.admin.client, t.mentorA.client, t.trainee.client]) {
      expect((await cancel(client, decisionId, { reason: 'x' })).status).toBe(403);
    }
    expect((await cancel(api.client(), decisionId, { reason: 'x' })).status).toBe(401);
    expect((await cancel(t.hrA.client, crypto.randomUUID(), { reason: 'x' })).status).toBe(404);
    // A reason is mandatory.
    const missing = await cancel(t.hrA.client, decisionId, {});
    expect((await body<{ errors: Record<string, string[]> }>(missing)).errors).toEqual({
      Reason: ['The Reason field is required.'],
    });
    const blank = await cancel(t.hrA.client, decisionId, { reason: '  ' });
    expect((await body<{ errors: Record<string, string[]> }>(blank)).errors).toEqual({
      Reason: ['The Reason field is required.'],
    });
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Pending']);

    const cancelled = await cancel(t.hrA.client, decisionId, { reason: ' Wrong mentor ' });
    expect(cancelled.status).toBe(200);
    expect(await body<Assignment>(cancelled)).toMatchObject({
      id: t.id,
      status: 'Active',
      canTransfer: true,
      canCancelTransfer: false,
      transferDecisions: [
        {
          id: decisionId,
          status: 'Cancelled',
          reason: 'Plan',
          resolutionReason: 'Wrong mentor',
          resolvedBy: expect.any(String),
        },
      ],
    });
    expect(await auditOfTransaction('transfer_decisions', decisionId, 'UPDATE')).toEqual([
      { table_name: 'transfer_decisions', operation: 'UPDATE', actor_type: 'Staff', actor_id: t.hrA.user.id },
    ]);
    const again = await cancel(t.hrA.client, decisionId, { reason: 'Again' });
    expect(again.status).toBe(400);
    expect((await body(again)).code).toBe('transfer_decision.invalid_status');

    // Reschedule: a new decision; the cancelled one is never executed.
    expect(
      (
        await transfer(t.hrA.client, t.id, {
          employeeId: t.mentorC.user.id,
          transferDate: addDays(today(), 4),
          reason: 'Plan B',
        })
      ).status,
    ).toBe(200);
    await runJob(new Date(Date.now() + 3 * DAY));
    expect((await decisions(t.applicationId)).map((d) => [d.status, d.effective, d.resolved_by_id])).toEqual([
      ['Cancelled', addDays(today(), 2), t.hrA.user.id],
      ['Pending', addDays(today(), 4), null],
    ]);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Active']);
  });

  it('after an Admin replacement the new responsible HR cancels and decides; the pending decision stays valid', async () => {
    const t = await training(api, addDays(today(), -30), addDays(today(), 30));
    const first = await body<Assignment>(
      await transfer(t.hrA.client, t.id, {
        employeeId: t.mentorB.user.id,
        transferDate: addDays(today(), 2),
        reason: 'By A',
      }),
    );
    const decisionId = first.transferDecisions[0]!.id;
    const replace = (hrId: string) =>
      t.admin.client.put(`/api/admin/accepted-trainees/${t.applicationId}/responsible-hr`, { hrId });
    expect((await replace(t.hrB.user.id)).status).toBe(200);
    // The decision stays Pending; HR A lost the authority, HR B gained it.
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Pending']);
    expect((await hrRow(t.hrA.client, t.id))?.canCancelTransfer).toBe(false);
    expect((await hrRow(t.hrB.client, t.id))?.canCancelTransfer).toBe(true);
    expect((await cancel(t.hrA.client, decisionId, { reason: 'x' })).status).toBe(403);
    expect(
      (await transfer(t.hrA.client, t.id, { employeeId: t.mentorC.user.id, transferDate: today(), reason: 'x' }))
        .status,
    ).toBe(403);
    expect((await cancel(t.hrB.client, decisionId, { reason: 'Changed by B' })).status).toBe(200);

    // HR B decides a new transfer, then loses the HR role: the decision stays valid and is executed on its date.
    const effective = addDays(today(), 3);
    expect(
      (await transfer(t.hrB.client, t.id, { employeeId: t.mentorC.user.id, transferDate: effective, reason: 'By B' }))
        .status,
    ).toBe(200);
    expect((await t.admin.client.put(`/api/admin/users/${t.hrB.user.id}/role`, { role: 'Employee' })).status).toBe(200);
    // Nobody may cancel it now (the responsible HR is no longer HR; HR A is not responsible).
    expect((await hrRow(t.hrA.client, t.id))?.canCancelTransfer).toBe(false);
    await runJob(hebronMidnight(effective));
    expect((await decisions(t.applicationId)).map((d) => [d.status, d.decided_by_id])).toEqual([
      ['Cancelled', t.hrA.user.id],
      ['Executed', t.hrB.user.id],
    ]);
    expect((await links(t.applicationId)).map((l) => l.transferred_by_id)).toEqual([t.hrB.user.id]);
    expect((await assignments(t.applicationId)).map((a) => [a.employee_id, a.status])).toEqual([
      [t.mentorA.user.id, 'Transferred'],
      [t.mentorC.user.id, 'Active'],
    ]);
  });
});

describe('scheduled execution of due transfers (AD-65)', () => {
  it('executes on the effective date: T-1 / T, the end date as extended meanwhile, System actor, deciding HR kept', async () => {
    const start = addDays(today(), -20);
    const t = await training(api, start, addDays(today(), 30));
    const effective = addDays(today(), 2);
    await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });
    // Any HR extends before the date (AD-63): the incoming assignment inherits the new end date.
    const extended = addDays(today(), 45);
    expect(
      (await t.hrB.client.post(`/api/hr/assignments/${t.id}/extend`, { endDate: extended, reason: 'More' })).status,
    ).toBe(200);

    // Just before the Asia/Hebron day starts: nothing happens.
    await runJob(new Date(hebronMidnight(effective).getTime() - 60_000));
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Pending']);

    const runAt = new Date(hebronMidnight(effective).getTime() + 5 * 60_000);
    await runJob(runAt);
    const rows = await assignments(t.applicationId);
    expect(rows.map((a) => [a.employee_id, a.status, a.start, a.end, a.end_reason])).toEqual([
      [t.mentorA.user.id, 'Transferred', start, addDays(effective, -1), 'Moved'],
      [t.mentorB.user.id, 'Active', effective, extended, null],
    ]);
    const [decision] = await decisions(t.applicationId);
    expect(decision).toMatchObject({ status: 'Executed', effective, decided_by_id: t.hrA.user.id, resolved: true });
    const [link] = await links(t.applicationId);
    expect(link).toMatchObject({ decision_id: decision!.id, transferred_by_id: t.hrA.user.id });
    expect(new Date(link!.transferred_at).getTime()).toBe(runAt.getTime()); // the actual time, not the date
    const system = { actor_type: 'System', actor_id: null };
    expect(await auditOfTransaction('transfer_decisions', decision!.id, 'UPDATE')).toEqual([
      { table_name: 'assignments', operation: 'UPDATE', ...system },
      { table_name: 'assignments', operation: 'INSERT', ...system },
      { table_name: 'assignment_transfers', operation: 'INSERT', ...system },
      { table_name: 'transfer_decisions', operation: 'UPDATE', ...system },
    ]);

    // Idempotent: another run changes nothing.
    await runJob(new Date(runAt.getTime() + DAY));
    expect(await assignments(t.applicationId)).toEqual(rows);
    expect(await links(t.applicationId)).toHaveLength(1);
  });

  it('concurrent runs execute a due decision exactly once', async () => {
    const t = await training(api, addDays(today(), -20), addDays(today(), 30));
    const effective = addDays(today(), 1);
    await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });
    const at = new Date(hebronMidnight(effective).getTime() + 60_000);
    await Promise.all([runJob(at), runJob(at), runJob(at)]);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Transferred', 'Active']);
    expect(await links(t.applicationId)).toHaveLength(1);
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Executed']);
  });

  it('a failed run leaves the decision Pending; a later run (after an outage) executes it with its own dates', async () => {
    const start = addDays(today(), -20);
    const end = addDays(today(), 30);
    const t = await training(api, start, end);
    const effective = addDays(today(), 1);
    await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });

    // Every transaction fails after its work (as a lost connection would): rolled back, nothing kept.
    const failing = (db: Database): TransactionalDatabase => ({
      query: (text, params) => db.query(text, params),
      transaction: <T>(actor: AuditActor, work: (tx: Queryable) => Promise<T>) =>
        db.transaction(actor, async (tx) => {
          await work(tx);
          throw new Error('connection lost');
        }),
    });
    const failed = await runJob(new Date(hebronMidnight(effective).getTime() + 60_000), failing);
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Pending']);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Active']);

    // Three days later (the runs in between were missed): executed with the decision's dates, at the actual time.
    const late = new Date(hebronMidnight(addDays(effective, 3)).getTime() + 60_000);
    await runJob(late);
    expect((await assignments(t.applicationId)).map((a) => [a.status, a.start, a.end])).toEqual([
      ['Transferred', start, addDays(effective, -1)],
      ['Active', effective, end],
    ]);
    expect(new Date((await links(t.applicationId))[0]!.transferred_at).getTime()).toBe(late.getTime());
  });

  it('voids the decision when the incoming mentor no longer holds the Employee role; the outgoing stays Active', async () => {
    const t = await training(api, addDays(today(), -20), addDays(today(), 30));
    const effective = addDays(today(), 1);
    await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });
    expect((await t.admin.client.put(`/api/admin/users/${t.mentorB.user.id}/role`, { role: 'HR' })).status).toBe(200);

    await runJob(new Date(hebronMidnight(effective).getTime() + 60_000));
    expect(await decisions(t.applicationId)).toMatchObject([
      { status: 'Void', resolution_code: 'mentor_not_employee', resolved_by_id: null, resolved: true },
    ]);
    expect((await assignments(t.applicationId)).map((a) => [a.employee_id, a.status])).toEqual([
      [t.mentorA.user.id, 'Active'],
    ]);
    expect(await links(t.applicationId)).toEqual([]);
    expect(await hrRow(t.hrA.client, t.id)).toMatchObject({
      canTransfer: true,
      canCancelTransfer: false,
      transferDecisions: [{ status: 'Void', resolutionCode: 'mentor_not_employee' }],
    });
  });

  it('ending the training before the date voids its pending transfer at once (withdrawal, early completion)', async () => {
    for (const [action, payload, status] of [
      ['withdraw', { endDate: today(), reason: 'Left' }, 'Withdrawn'],
      ['complete', { endDate: today(), reason: 'Finished early' }, 'EndedEarly'],
    ] as const) {
      const t = await training(api, addDays(today(), -20), addDays(today(), 30));
      const effective = addDays(today(), 2);
      await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });
      const ended = await t.hrB.client.post(`/api/hr/assignments/${t.id}/${action}`, payload);
      expect(ended.status, action).toBe(200);
      const [decision] = await decisions(t.applicationId);
      expect(decision, action).toMatchObject({ status: 'Void', resolution_code: 'training_ended', resolved: true });
      expect(await auditOfTransaction('transfer_decisions', decision!.id, 'UPDATE')).toEqual([
        { table_name: 'assignments', operation: 'UPDATE', actor_type: 'Staff', actor_id: t.hrB.user.id },
        { table_name: 'transfer_decisions', operation: 'UPDATE', actor_type: 'Staff', actor_id: t.hrB.user.id },
      ]);
      await runJob(new Date(hebronMidnight(effective).getTime() + 60_000));
      expect(
        (await assignments(t.applicationId)).map((a) => a.status),
        action,
      ).toEqual([status]);
      expect(await links(t.applicationId)).toEqual([]);
    }
  });

  it('gap guards: on the effective day, before the run, notes and lifecycle changes wait (409); then the new mentor', async () => {
    const t = await training(api, addDays(today(), -20), addDays(today(), 30));
    const effective = addDays(today(), 1);
    await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });
    api.clock.offsetMs = DAY; // the effective day has started, the scheduled run has not happened yet

    const due = async (response: Response, what: string) => {
      expect(response.status, what).toBe(409);
      expect((await body(response)).code, what).toBe('assignment.transfer_due');
    };
    await due(await note(t.mentorA.client, t.id, 'Too late'), 'note');
    await due(
      await t.hrA.client.post(`/api/hr/assignments/${t.id}/extend`, { endDate: addDays(today(), 40), reason: 'x' }),
      'extend',
    );
    await due(
      await t.hrA.client.post(`/api/hr/assignments/${t.id}/complete`, { endDate: effective, reason: 'x' }),
      'complete',
    );
    await due(
      await t.hrA.client.post(`/api/hr/assignments/${t.id}/withdraw`, { endDate: effective, reason: 'x' }),
      'withdraw',
    );
    const another = await transfer(t.hrA.client, t.id, {
      employeeId: t.mentorC.user.id,
      transferDate: effective,
      reason: 'x',
    });
    expect((await body(another)).code).toBe('assignment.transfer_pending');
    expect((await assignments(t.applicationId)).map((a) => [a.status, a.end])).toEqual([
      ['Active', addDays(today(), 30)],
    ]);
    const notes = await withDb((db) =>
      db.query('SELECT 1 FROM progress_notes WHERE assignment_id = $1', [t.id]).then((r) => r.rowCount),
    );
    expect(notes).toBe(0);

    await runJob(api.clock.now());
    const incoming = (await assignments(t.applicationId)).find((a) => a.status === 'Active')!;
    expect((await note(t.mentorA.client, t.id, 'Too late')).status).toBe(400); // progress_note.not_active
    expect((await note(t.mentorB.client, incoming.id, 'First note by B')).status).toBe(201);
  });

  it('the Cron Trigger handler runs the job with the clock of the run', async () => {
    const t = await training(api, addDays(today(), -20), addDays(today(), 30));
    const effective = addDays(today(), 1);
    await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: effective, reason: 'Moved' });
    const at = new Date(hebronMidnight(effective).getTime() + 5 * 60_000);
    const ctx = createExecutionContext();
    createScheduledHandler({ now: () => at })(
      createScheduledController({ scheduledTime: at.getTime(), cron: '5 3,21,22 * * *' }),
      env as unknown as Bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect((await decisions(t.applicationId)).map((d) => d.status)).toEqual(['Executed']);
  });
});

describe('earlier mentors’ progress notes (AD-65)', () => {
  const earlier = (client: TestClient, id: string) => client.get(`/api/employee/assignments/${id}/earlier-notes`);

  it('the latest mentor reads every earlier note, also after the training ends; earlier mentors only their own', async () => {
    const t = await training(api, addDays(today(), -40), addDays(today(), 20));
    const stranger = await signInStaff(api, 'Employee'); // signed in before the clock moves (Google tokens)
    expect((await note(t.mentorA.client, t.id, 'Note by A')).status).toBe(201);
    const b = await body<Assignment>(
      await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: today(), reason: 'x' }),
    );
    // The outgoing assignment is closed: A cannot add notes to it any more.
    expect((await note(t.mentorA.client, t.id, 'Late')).status).toBe(400);
    expect((await note(t.mentorB.client, b.id, 'Note by B')).status).toBe(201);
    // The same day again would leave B's assignment ending before it starts: refused.
    const sameDay = await transfer(t.hrA.client, b.id, {
      employeeId: t.mentorC.user.id,
      transferDate: today(),
      reason: 'y',
    });
    expect((await body(sameDay)).code).toBe('assignment.transfer_not_after_start');
    const tomorrow = addDays(today(), 1);
    expect(
      (await transfer(t.hrA.client, b.id, { employeeId: t.mentorC.user.id, transferDate: tomorrow, reason: 'y' }))
        .status,
    ).toBe(200);
    // Before execution C has no access to the training and B is still the latest mentor.
    expect((await earlier(t.mentorC.client, b.id)).status).toBe(404);
    await runJob(new Date(hebronMidnight(tomorrow).getTime() + 60_000));
    api.clock.offsetMs = DAY;
    const c = (await assignments(t.applicationId)).at(-1)!;
    expect(c).toMatchObject({ employee_id: t.mentorC.user.id, status: 'Active', start: tomorrow });
    expect((await note(t.mentorC.client, c.id, 'Note by C')).status).toBe(201);

    // C (latest) reads A's and B's notes, read-only, with their assignment context; not its own here.
    const read = await earlier(t.mentorC.client, c.id);
    expect(read.status).toBe(200);
    const notes = await body<{ text: string; authorName: string; assignment: { startDate: string } }[]>(read);
    expect(notes.map((n) => n.text)).toEqual(['Note by A', 'Note by B']);
    expect(notes[1]!.assignment.startDate).toBe(today());

    // The flag in My trainees: only on the latest assignment.
    const flag = async (client: TestClient, id: string) =>
      (await body<{ id: string; canReadEarlierNotes: boolean }[]>(await client.get('/api/employee/trainees'))).find(
        (a) => a.id === id,
      )?.canReadEarlierNotes;
    expect(await flag(t.mentorC.client, c.id)).toBe(true);
    expect(await flag(t.mentorB.client, b.id)).toBe(false);
    expect(await flag(t.mentorA.client, t.id)).toBe(false);

    // Earlier mentors: their own notes only; never the others'.
    for (const [mentor, own] of [
      [t.mentorA, t.id],
      [t.mentorB, b.id],
    ] as const) {
      const refused = await earlier(mentor.client, own);
      expect(refused.status).toBe(403);
      expect((await body(refused)).code).toBe('progress_note.not_latest_mentor');
      expect((await mentor.client.get(`/api/employee/assignments/${own}/notes`)).status).toBe(200);
    }
    expect((await t.mentorA.client.get(`/api/employee/assignments/${b.id}/notes`)).status).toBe(404);
    expect((await earlier(t.mentorA.client, c.id)).status).toBe(404);

    // Unrelated employee, HR and trainee: no access.
    expect((await earlier(stranger.client, c.id)).status).toBe(404);
    expect((await earlier(t.hrA.client, c.id)).status).toBe(403);
    expect((await earlier(t.trainee.client, c.id)).status).toBe(403);

    // After the training ends, C still reads them; the notes themselves are unchanged.
    expect(
      (await t.hrA.client.post(`/api/hr/assignments/${c.id}/complete`, { endDate: tomorrow, reason: 'Done' })).status,
    ).toBe(200);
    expect((await body<unknown[]>(await earlier(t.mentorC.client, c.id))).length).toBe(2);
    const stored = await withDb((db) =>
      db.query<{ text: string; assignment_id: string }>(
        `SELECT n.text, n.assignment_id FROM progress_notes n JOIN assignments s ON s.id = n.assignment_id
          WHERE s.application_id = $1 ORDER BY n.written_at`,
        [t.applicationId],
      ),
    );
    expect(stored.rows).toEqual([
      { text: 'Note by A', assignment_id: t.id },
      { text: 'Note by B', assignment_id: b.id },
      { text: 'Note by C', assignment_id: c.id },
    ]);
  });
});

describe('Asia/Hebron calendar day and daylight saving', () => {
  it('"today" is the Hebron date: at 22:30 UTC the next UTC day is immediate, not in the past', async () => {
    // Sign in at the real time, then move this API's clock forward (less than a day) to the next 22:30 UTC.
    const hebron = createTestApi();
    const now = new Date();
    const at = new Date(`${now.toISOString().slice(0, 10)}T22:30:00Z`);
    if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
    const utcDay = at.toISOString().slice(0, 10);
    const hebronDay = calendarDate(at);
    expect(hebronDay).toBe(addDays(utcDay, 1));

    const t = await training(hebron, addDays(utcDay, -20), addDays(utcDay, 30));
    hebron.clock.offsetMs = at.getTime() - Date.now();
    const past = await transfer(t.hrA.client, t.id, {
      employeeId: t.mentorB.user.id,
      transferDate: utcDay,
      reason: 'Moved',
    });
    expect((await body(past)).code).toBe('assignment.transfer_in_past');
    const ok = await transfer(t.hrA.client, t.id, {
      employeeId: t.mentorB.user.id,
      transferDate: hebronDay,
      reason: 'Moved',
    });
    expect(ok.status).toBe(200);
    expect((await assignments(t.applicationId)).map((a) => [a.status, a.start, a.end])).toEqual([
      ['Transferred', addDays(utcDay, -20), utcDay],
      ['Active', hebronDay, addDays(utcDay, 30)],
    ]);
  });

  it('a scheduled transfer runs at the Hebron midnight in winter (UTC+2) and summer (UTC+3); the cron hours cover both', async () => {
    const winter = '2027-01-15';
    const summer = '2027-07-15';
    expect(hebronMidnight(winter).toISOString()).toBe('2027-01-14T22:00:00.000Z');
    expect(hebronMidnight(summer).toISOString()).toBe('2027-07-14T21:00:00.000Z');
    // The Cron Trigger hours 21 and 22 UTC: one of them is 00:05 Asia/Hebron on the effective day in each season.
    for (const day of [winter, summer]) {
      const runs = ['21', '22'].map((h) => calendarDate(new Date(`${addDays(day, -1)}T${h}:05:00Z`)));
      expect(runs, day).toContain(day);
    }

    for (const day of [winter, summer]) {
      const t = await training(api, addDays(today(), -10), '2027-08-31');
      await transfer(t.hrA.client, t.id, { employeeId: t.mentorB.user.id, transferDate: day, reason: 'Moved' });
      await runJob(new Date(hebronMidnight(day).getTime() - 60_000));
      expect(
        (await decisions(t.applicationId)).map((d) => d.status),
        day,
      ).toEqual(['Pending']);
      await runJob(new Date(hebronMidnight(day).getTime() + 60_000));
      expect(
        (await assignments(t.applicationId)).map((a) => [a.status, a.end]),
        day,
      ).toEqual([
        ['Transferred', addDays(day, -1)],
        ['Active', '2027-08-31'],
      ]);
    }
  });
});
