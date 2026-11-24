import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { calendarDate } from '../src/domain/training';
import { body, setRole, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-database';
import { newField, submitApplication } from './seed';

/**
 * HR approval of a mentor request (owner decisions of 2026-11-23, after the reproduced lifecycle defect): an application
 * never gets a second initial assignment once it has had any assignment (409 mentor_request.already_assigned, nothing
 * written); approving one request rejects every other pending request for the application in the same transaction,
 * with the approved bilingual reason, by the approving HR; the rejected employees get the ordinary rejection
 * notification and e-mail (after the commit), except an employee who holds the Admin role now and the approved employee
 * (for a duplicate request of their own). Transfers keep their own workflow.
 *
 * A database of its own (alternative B, test/isolated-database.ts), e-mails captured by the test sender (never sent);
 * its tests run in order. Races are synchronized by observed lock waits, never by time.
 */
const AUTO_REJECTION_REASON =
  "وافقت الموارد البشرية على طلب موظف آخر لتدريب هذا المتدرب. / HR approved another employee's request to train this trainee.";
const REJECTED_SUBJECT = 'Training request not approved';
const APPROVED_SUBJECT = 'Training request approved';
const TRAINEE_APPROVED_SUBJECT = 'Your mentor assignment has been approved';

let isolated: IsolatedDatabase;
let api: TestApi;
let admin: { client: TestClient; user: { id: string }; email: string };

beforeAll(async () => {
  isolated = await createIsolatedDatabase();
  api = isolated.api({}, { EVENT_EMAILS: 'enabled' });
  admin = await signInStaff(api, 'Admin');
});

const db = <T>(work: (client: pg.Client) => Promise<T>) => withDb(work, isolated.ownerUrl);
const today = () => calendarDate(new Date());
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const code = async (response: Response) => [response.status, (await body<{ code?: string }>(response)).code];

/** An accepted application (its responsible HR accepted it), with three employees, a second HR and the trainee. */
async function accepted() {
  const hr = await signInStaff(api, 'HR');
  const hr2 = await signInStaff(api, 'HR');
  const a = await signInStaff(api, 'Employee');
  const b = await signInStaff(api, 'Employee');
  const c = await signInStaff(api, 'Employee');
  const trainee = await signInTrainee(api);
  const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Mentor Trainee');
  expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  return { hr, hr2, a, b, c, trainee, applicationId };
}
type Training = Awaited<ReturnType<typeof accepted>>;

const ask = async (client: TestClient, applicationId: string) => {
  const response = await client.post('/api/employee/mentor-requests', { applicationId, note: 'I can train them' });
  expect(response.status).toBe(201);
  return (await body<{ id: string }>(response)).id;
};
const approve = (client: TestClient, requestId: string, start = addDays(today(), -30), end = today()) =>
  client.post(`/api/hr/mentor-requests/${requestId}/approve`, { startDate: start, endDate: end });

/** A Pending request recorded before these rules (historical data): written by the owner, as the System actor. */
const legacyPending = (applicationId: string, employeeId: string) =>
  db(async (client) => {
    const id = crypto.randomUUID();
    await client.query('BEGIN');
    await client.query("SELECT set_config('ims.actor_type', 'System', true)");
    await client.query(
      `INSERT INTO mentor_requests (id, employee_id, application_id, note, status, requested_at)
       VALUES ($1, $2, $3, 'Historical request', 'Pending', now())`,
      [id, employeeId, applicationId],
    );
    await client.query('COMMIT');
    return id;
  });

const assignments = (applicationId: string) =>
  db((client) =>
    client.query<{ id: string; employee_id: string; status: string; request: string | null }>(
      `SELECT id, employee_id, status, mentor_request_id AS request FROM assignments
        WHERE application_id = $1 ORDER BY created_at`,
      [applicationId],
    ),
  ).then((r) => r.rows);
const requests = (applicationId: string) =>
  db((client) =>
    client.query<{ id: string; employee_id: string; status: string; by: string | null; reason: string | null }>(
      `SELECT id, employee_id, status, decided_by_id AS by, rejection_reason AS reason FROM mentor_requests
        WHERE application_id = $1 ORDER BY requested_at, id`,
      [applicationId],
    ),
  ).then((r) => r.rows);
const notificationsOf = (employeeId: string) =>
  db((client) =>
    client.query<{ type: string; entity: string }>(
      `SELECT type, entity_id AS entity FROM notifications
        WHERE recipient_id = $1 AND type IN ('MentorRequestApproved', 'MentorRequestRejected') ORDER BY created_at`,
      [employeeId],
    ),
  ).then((r) => r.rows);
const mailsTo = (email: string, subject: string) =>
  api.emails.sent.filter((m) => m.to === email && m.subject.includes(subject)).length;
/** Every audit row of the application's requests and assignments (a refused approval adds none). */
const audits = (applicationId: string) =>
  db((client) =>
    client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs a
        WHERE (a.table_name = 'mentor_requests'
               AND a.entity_id IN (SELECT id::text FROM mentor_requests WHERE application_id = $1))
           OR (a.table_name = 'assignments'
               AND a.entity_id IN (SELECT id::text FROM assignments WHERE application_id = $1))
           OR (a.table_name = 'notifications' AND a.new_values ->> 'entity_id' IN (
                 SELECT id::text FROM mentor_requests WHERE application_id = $1))`,
      [applicationId],
    ),
  ).then((r) => r.rows[0]!.n);
/** The whole state a refused approval must leave as it was. */
const snapshot = async (t: Training) => ({
  assignments: await assignments(t.applicationId),
  requests: await requests(t.applicationId),
  audits: await audits(t.applicationId),
  mails: api.emails.sent.length,
});

// ── Lock observation ─────────────────────────────────────────────────────────────────────────────────────────────

/** Sessions blocked by `pid`, directly or behind another waiter (a row-lock queue). */
async function blockedBy(pid: number, count: number, statement: string) {
  for (let waited = 0; waited <= 10_000; waited += 25) {
    const { rows } = await db((client) =>
      client.query<{ query: string }>(
        `WITH first AS (SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))
         SELECT a.query FROM pg_stat_activity a
          WHERE a.pid IN (SELECT pid FROM first)
             OR EXISTS (SELECT 1 FROM first f WHERE f.pid = ANY(pg_blocking_pids(a.pid)))`,
        [pid],
      ),
    );
    if (rows.length >= count && rows.filter((r) => r.query.includes(statement)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${count} session(s) blocked in: ${statement}`);
}

/** An owner transaction holding `statements` until `end`; always closed in `finally`. */
async function holding<T>(
  statements: [string, unknown[]][],
  work: (pid: number, end: (how: 'COMMIT' | 'ROLLBACK') => Promise<void>) => Promise<T>,
) {
  const client = new pg.Client({ connectionString: isolated.ownerUrl });
  client.on('error', () => undefined);
  await client.connect();
  let open = true;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('ims.actor_type', 'System', true)");
    for (const [text, params] of statements) await client.query(text, params);
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return await work(pid, async (how) => {
      if (open) {
        open = false;
        await client.query(how);
      }
    });
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

// ── Rule 2: approving one request rejects the others, atomically ─────────────────────────────────────────────────

describe('approving a mentor request rejects every other pending request for the application', () => {
  it('one assignment; the others Rejected by the approving HR with the approved reason; audited in one transaction', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const rb = await ask(t.b.client, t.applicationId);
    const rc = await ask(t.c.client, t.applicationId);
    const response = await approve(t.hr.client, ra);
    expect(response.status).toBe(200);

    expect((await assignments(t.applicationId)).map((s) => [s.employee_id, s.status, s.request])).toEqual([
      [t.a.user.id, 'Active', ra],
    ]);
    expect(await requests(t.applicationId)).toEqual([
      { id: ra, employee_id: t.a.user.id, status: 'Approved', by: t.hr.user.id, reason: null },
      { id: rb, employee_id: t.b.user.id, status: 'Rejected', by: t.hr.user.id, reason: AUTO_REJECTION_REASON },
      { id: rc, employee_id: t.c.user.id, status: 'Rejected', by: t.hr.user.id, reason: AUTO_REJECTION_REASON },
    ]);
    // One transaction, audited as the approving HR: the approval, the two rejections and the assignment.
    const audit = await db((client) =>
      client.query<{ tx: string; actor: string; n: number }>(
        `SELECT transaction_id::text AS tx, actor_id::text AS actor, count(*)::int AS n FROM audit_logs
          WHERE (table_name = 'mentor_requests' AND entity_id = ANY($1::text[]) AND operation = 'UPDATE')
             OR (table_name = 'assignments' AND new_values ->> 'application_id' = $2 AND operation = 'INSERT')
          GROUP BY 1, 2`,
        [[ra, rb, rc], t.applicationId],
      ),
    );
    expect(audit.rows).toEqual([{ tx: audit.rows[0]!.tx, actor: t.hr.user.id, n: 4 }]);
    // A rejected request can no longer be approved (the request was already decided).
    expect(await code(await approve(t.hr2.client, rb))).toEqual([400, 'mentor_request.invalid_status']);
  });

  it('notices: ordinary rejection (in-app, then e-mail after the commit) for the others; approval and trainee e-mail as before', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const rb = await ask(t.b.client, t.applicationId);
    expect((await approve(t.hr.client, ra)).status).toBe(200);
    expect(await notificationsOf(t.b.user.id)).toEqual([{ type: 'MentorRequestRejected', entity: rb }]);
    expect(await notificationsOf(t.a.user.id)).toEqual([{ type: 'MentorRequestApproved', entity: ra }]);
    expect(mailsTo(t.b.email, REJECTED_SUBJECT)).toBe(1);
    expect(mailsTo(t.a.email, APPROVED_SUBJECT)).toBe(1);
    expect(mailsTo(t.a.email, REJECTED_SUBJECT)).toBe(0);
    const traineeEmail = await db((client) =>
      client.query<{ email: string }>(
        'SELECT t.email FROM trainees t JOIN training_applications a ON a.trainee_id = t.id WHERE a.id = $1',
        [t.applicationId],
      ),
    ).then((r) => r.rows[0]!.email);
    expect(mailsTo(traineeEmail, TRAINEE_APPROVED_SUBJECT)).toBe(1);
  });

  it('exceptions: no rejection notice for a requester who is an Admin now, nor for the approved employee’s duplicate', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const raDuplicate = await ask(t.a.client, t.applicationId);
    const rb = await ask(t.b.client, t.applicationId);
    const rc = await ask(t.c.client, t.applicationId);
    await setRole(t.b.email, 'Admin', isolated.ownerUrl); // holds the Admin role now
    expect((await approve(t.hr.client, ra)).status).toBe(200);
    expect((await requests(t.applicationId)).map((r) => [r.id, r.status, r.reason])).toEqual([
      [ra, 'Approved', null],
      [raDuplicate, 'Rejected', AUTO_REJECTION_REASON],
      [rb, 'Rejected', AUTO_REJECTION_REASON],
      [rc, 'Rejected', AUTO_REJECTION_REASON],
    ]);
    expect(await notificationsOf(t.a.user.id)).toEqual([{ type: 'MentorRequestApproved', entity: ra }]);
    expect(await notificationsOf(t.b.user.id)).toEqual([]);
    expect(await notificationsOf(t.c.user.id)).toEqual([{ type: 'MentorRequestRejected', entity: rc }]);
    expect([mailsTo(t.a.email, REJECTED_SUBJECT), mailsTo(t.b.email, REJECTED_SUBJECT)]).toEqual([0, 0]);
    expect([mailsTo(t.a.email, APPROVED_SUBJECT), mailsTo(t.c.email, REJECTED_SUBJECT)]).toEqual([1, 1]);
    await setRole(t.b.email, 'Employee', isolated.ownerUrl);
  });

  it('rollback: when the approval fails after its writes, nothing is approved, rejected, assigned, audited or sent', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    await ask(t.b.client, t.applicationId);
    const before = await snapshot(t);
    // A concurrent, still uncommitted Active assignment of the application: the approval's own INSERT waits on the
    // unique index, then fails when it commits (23505, the existing 409 conflict.duplicate).
    const result = await holding(
      [
        [
          `INSERT INTO assignments (id, application_id, employee_id, start_date, end_date, status, created_at)
           VALUES (gen_random_uuid(), $1, $2, current_date, current_date + 10, 'Active', now())`,
          [t.applicationId, t.c.user.id],
        ],
      ],
      async (pid, end) => {
        const pending = approve(t.hr.client, ra);
        await blockedBy(pid, 1, 'INSERT INTO assignments');
        await end('COMMIT');
        return code(await pending);
      },
    );
    expect(result).toEqual([409, 'conflict.duplicate']);
    const after = await snapshot(t);
    expect(after.requests).toEqual(before.requests); // both still Pending, nothing decided
    expect(after.mails).toBe(before.mails);
    expect((await notificationsOf(t.a.user.id)).length + (await notificationsOf(t.b.user.id)).length).toBe(0);
    expect(after.assignments.map((s) => s.employee_id)).toEqual([t.c.user.id]); // only the holder's
  });
});

// ── Rule 1: never a second initial assignment ────────────────────────────────────────────────────────────────────

describe('a request cannot be approved once the application has had any assignment', () => {
  const ending: [string, (t: Training, assignmentId: string) => Promise<void>][] = [
    ['Active', async () => undefined],
    [
      'Completed',
      async (t, id) => {
        expect((await t.hr.client.post(`/api/hr/assignments/${id}/complete`, { endDate: today() })).status).toBe(200);
      },
    ],
    [
      'EndedEarly',
      async (t, id) => {
        const r = await t.hr.client.post(`/api/hr/assignments/${id}/complete`, { endDate: today(), reason: 'Early' });
        expect(r.status).toBe(200);
      },
    ],
    [
      'Withdrawn',
      async (t, id) => {
        const r = await t.hr.client.post(`/api/hr/assignments/${id}/withdraw`, { endDate: today(), reason: 'Left' });
        expect(r.status).toBe(200);
      },
    ],
  ];

  it.each(ending)(
    'after the first assignment is %s: 409 mentor_request.already_assigned, nothing written',
    async (_s, end) => {
      const t = await accepted();
      const ra = await ask(t.a.client, t.applicationId);
      const long = _s === 'EndedEarly' || _s === 'Withdrawn' ? addDays(today(), 30) : today();
      expect((await approve(t.hr.client, ra, addDays(today(), -30), long)).status).toBe(200);
      const first = (await assignments(t.applicationId))[0]!;
      await end(t, first.id);
      const historical = await legacyPending(t.applicationId, t.b.user.id); // a request left Pending from before
      const before = await snapshot(t);
      expect(await code(await approve(t.hr.client, historical))).toEqual([409, 'mentor_request.already_assigned']);
      expect(await snapshot(t)).toEqual(before);
      expect(await notificationsOf(t.b.user.id)).toEqual([]);
    },
  );

  it('a legitimate transfer still works; after it ends, a historical request still cannot start a second training', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    expect((await approve(t.hr.client, ra, addDays(today(), -30), addDays(today(), 30))).status).toBe(200);
    const first = (await assignments(t.applicationId))[0]!;
    const moved = await t.hr.client.post(`/api/hr/assignments/${first.id}/transfer`, {
      employeeId: t.c.user.id,
      transferDate: today(),
      reason: 'Synthetic transfer',
    });
    expect(moved.status).toBe(200);
    const current = (await assignments(t.applicationId)).find((s) => s.status === 'Active')!;
    expect(current.employee_id).toBe(t.c.user.id);
    const ended = await t.hr.client.post(`/api/hr/assignments/${current.id}/complete`, {
      endDate: today(),
      reason: 'Early',
    });
    expect(ended.status).toBe(200);
    const historical = await legacyPending(t.applicationId, t.b.user.id);
    expect(await code(await approve(t.hr.client, historical))).toEqual([409, 'mentor_request.already_assigned']);
    expect((await assignments(t.applicationId)).map((s) => [s.employee_id, s.status])).toEqual([
      [t.a.user.id, 'Transferred'],
      [t.c.user.id, 'EndedEarly'],
    ]);
  });

  it('the final mentor stays the final mentor: the assignment history is unchanged after a refused second approval', async () => {
    // RELEASE-CANDIDATE ADAPTATION (09bab76 has no evaluation endpoints): the /api/evaluations checks of 4948a62 are
    // replaced by the assignment history they rely on: still exactly the first mentor's one Completed assignment.
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    expect((await approve(t.hr.client, ra)).status).toBe(200);
    const first = (await assignments(t.applicationId))[0]!;
    expect((await t.hr.client.post(`/api/hr/assignments/${first.id}/complete`, { endDate: today() })).status).toBe(200);
    const historical = await legacyPending(t.applicationId, t.b.user.id);
    expect((await approve(t.hr.client, historical)).status).toBe(409);
    expect((await assignments(t.applicationId)).map((s) => [s.employee_id, s.status])).toEqual([
      [t.a.user.id, 'Completed'],
    ]);
    const reportRows = await db((client) =>
      client.query<{ n: number }>('SELECT count(*)::int AS n FROM assignments WHERE application_id = $1', [
        t.applicationId,
      ]),
    ).then((r) => r.rows[0]!.n);
    expect(reportRows).toBe(1); // the monthly report's input: one training
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('concurrent decisions on the same application', () => {
  /** The owner locks the application's pending requests, so the racing requests queue behind it. */
  const lockPending = (applicationId: string): [string, unknown[]] => [
    "SELECT id FROM mentor_requests WHERE application_id = $1 AND status = 'Pending' ORDER BY id FOR UPDATE",
    [applicationId],
  ];
  const APPROVAL_LOCK = "FROM mentor_requests WHERE application_id = $1 AND status = 'Pending' ORDER BY id FOR UPDATE";

  it('two HR users approve two different requests: exactly one assignment; the loser gets 409 concurrent_update', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const rb = await ask(t.b.client, t.applicationId);
    const results = await holding([lockPending(t.applicationId)], async (pid, end) => {
      const both = [approve(t.hr.client, ra), approve(t.hr2.client, rb)];
      await blockedBy(pid, 2, APPROVAL_LOCK);
      await end('COMMIT');
      return Promise.all(both.map(async (p) => code(await p)));
    });
    expect(results.map((r) => r[0]).sort()).toEqual([200, 409]);
    expect(results.find((r) => r[0] === 409)![1]).toBe('conflict.concurrent_update');
    const rows = await requests(t.applicationId);
    expect(rows.map((r) => r.status).sort()).toEqual(['Approved', 'Rejected']);
    expect(await assignments(t.applicationId)).toHaveLength(1);
  });

  it('two HR users approve the same request: one 200, the other 409 concurrent_update; one assignment', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const results = await holding([lockPending(t.applicationId)], async (pid, end) => {
      const both = [approve(t.hr.client, ra), approve(t.hr2.client, ra)];
      await blockedBy(pid, 2, APPROVAL_LOCK);
      await end('COMMIT');
      return Promise.all(both.map(async (p) => code(await p)));
    });
    expect(results.map((r) => r[0]).sort()).toEqual([200, 409]);
    expect(results.find((r) => r[0] === 409)![1]).toBe('conflict.concurrent_update');
    expect(await assignments(t.applicationId)).toHaveLength(1);
  });

  it('an approval and an ordinary rejection of the same request: one wins, the other 409; consistent state', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const results = await holding([lockPending(t.applicationId)], async (pid, end) => {
      const approval = approve(t.hr.client, ra);
      await blockedBy(pid, 1, APPROVAL_LOCK);
      const rejection = t.hr2.client.post(`/api/hr/mentor-requests/${ra}/reject`);
      await blockedBy(pid, 2, 'mentor_requests');
      await end('COMMIT');
      return [await code(await approval), await code(await rejection)];
    });
    expect(results.map((r) => r[0]).sort()).toEqual([200, 409]);
    const status = (await requests(t.applicationId))[0]!.status;
    expect(await assignments(t.applicationId)).toHaveLength(status === 'Approved' ? 1 : 0);
  });

  it('an approval and a direct assignment: one assignment; the loser 409; nothing partial', async () => {
    const t = await accepted();
    const ra = await ask(t.a.client, t.applicationId);
    const results = await holding([lockPending(t.applicationId)], async (pid, end) => {
      const approval = approve(t.hr2.client, ra);
      const direct = t.hr.client.post(`/api/hr/applications/${t.applicationId}/direct-assignment`, {
        employeeId: t.c.user.id,
        startDate: addDays(today(), -30),
        endDate: today(),
      });
      await blockedBy(pid, 2, "AND status = 'Pending' ORDER BY id FOR UPDATE");
      await end('COMMIT');
      return [await code(await approval), await code(await direct)];
    });
    expect([
      [200, 409],
      [201, 409],
    ]).toContainEqual(results.map((r) => r[0] as number).sort());
    expect(await assignments(t.applicationId)).toHaveLength(1);
    expect((await requests(t.applicationId))[0]!.status).not.toBe('Pending');
  });

  it('leaves no lock or open transaction behind', async () => {
    const left = await db((client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND (wait_event_type = 'Lock' OR state LIKE 'idle in transaction%')`,
      ),
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});
