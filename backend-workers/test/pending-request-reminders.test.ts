import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/config';
import { Database, type Queryable } from '../src/db';
import type { EmailMessage, EmailSender } from '../src/email';
import { renderEventEmail } from '../src/features/notifications/eventEmails';
import {
  isOverdue,
  isPendingReminderRun,
  officialHour,
  parseActivationCutoff,
  PENDING_REMINDER_CRON,
  pendingRequestAlertDays,
  remindPendingRequests,
} from '../src/features/notifications/pendingRequestReminders';
import type { TransactionalDatabase } from '../src/features/training/transfers';
import { createScheduledHandler, TRANSFER_CRON } from '../src/scheduled';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, unique, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * NEW-05 (AD-61 items 4–17): one e-mail reminder to HR per request still pending after N × 24 hours, N being the Admin
 * setting `pending_request_alert_days`. Applications (Submitted / Under Review, from `submitted_at`) go to every HR
 * user; mentor requests (Pending, from `requested_at`) to the application's current responsible HR only. Never twice,
 * never to anyone else, nothing recorded while nobody may receive it or while event e-mails are off.
 *
 * The job scans the whole (shared) test database, so each test backdates its own requests and asserts only on them.
 * E-mail is always a test double: nothing leaves the test.
 */
const api = createTestApi({}, { EVENT_EMAILS: 'enabled' });
const SITE = 'http://localhost:4200';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const APPLICATION_SUBJECT = 'طلب تدريب معلّق / Training application pending';
const MENTOR_REQUEST_SUBJECT = 'طلب تدريب متدرب معلّق / Request to train a trainee pending';
const HR_SQL = "SELECT id, email FROM employees WHERE role = 'HR' ORDER BY id";
/** A launch cutoff before every request these tests create (the cutoff itself is tested in its own suite). */
const EARLY_CUTOFF = new Date('2000-01-01T00:00:00Z');

afterEach(() => {
  vi.restoreAllMocks();
});

/** A test SMTP double: records every attempt; refuses the addresses in `failFor` (or every one). */
function smtp(options: { failFor?: string[]; failAll?: boolean } = {}) {
  const attempted: string[] = [];
  const accepted: EmailMessage[] = [];
  const sender: EmailSender = {
    async send(message) {
      attempted.push(message.to);
      if (options.failAll || options.failFor?.includes(message.to)) throw new Error('smtp refused (test)');
      accepted.push(message);
    },
  };
  return { sender, attempted, accepted };
}

/**
 * The job's database as the Worker uses it (as ims_app), optionally as if nobody held the HR role (`noHr`) or with a
 * different Admin threshold (`alertDays`): the shared test database cannot be emptied of HR users, and the shared
 * setting is not changed under other test files.
 */
function jobDatabase(
  db: Database,
  options: { noHr?: boolean; alertDays?: number; extraCandidates?: { kind: string; id: string }[] },
): TransactionalDatabase {
  const wrap = (inner: Queryable): Queryable => ({
    query: async (sql, params) => {
      if (options.noHr && sql === HR_SQL) return { rows: [], rowCount: 0 };
      if (options.extraCandidates && sql.includes('UNION ALL')) {
        // A stale or concurrent candidate list: the claim's own check under the row lock must still refuse these.
        const result = await inner.query(sql, params);
        const rows = [...result.rows, ...options.extraCandidates] as never[];
        return { rows, rowCount: rows.length };
      }
      if (options.alertDays !== undefined && sql.includes('pending_request_alert_days AS days')) {
        return { rows: [{ days: options.alertDays } as never], rowCount: 1 };
      }
      return inner.query(sql, params);
    },
  });
  return { ...wrap(db), transaction: (actor, work) => db.transaction(actor, (tx) => work(wrap(tx))) };
}

async function run(
  options: {
    now?: Date;
    enabled?: boolean;
    mail?: ReturnType<typeof smtp>;
    noHr?: boolean;
    alertDays?: number;
    activatedAt?: Date | null;
    extraCandidates?: { kind: string; id: string }[];
  } = {},
) {
  const mail = options.mail ?? smtp();
  const db = new Database((env as unknown as Bindings).DATABASE_URL!);
  try {
    const summary = await remindPendingRequests(jobDatabase(db, options), {
      now: options.now ?? new Date(),
      eventEmails: options.enabled ?? true,
      activatedAt: options.activatedAt === undefined ? EARLY_CUTOFF : options.activatedAt,
      sender: () => mail.sender,
      siteBaseUrl: SITE,
    });
    return { summary, mail };
  } finally {
    await db.close();
  }
}

/** Moves a request's start time (`submitted_at` / `requested_at`) as the System actor. */
async function backdate(table: 'training_applications' | 'mentor_requests', id: string, at: Date) {
  const column = table === 'training_applications' ? 'submitted_at' : 'requested_at';
  await withDb(async (db) => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('ims.actor_type', 'System', true)");
    await db.query(`UPDATE ${table} SET ${column} = $2 WHERE id = $1`, [id, at]);
    await db.query('COMMIT');
  });
}
const ago = (ms: number) => new Date(Date.now() - ms);

interface ReminderRow {
  id: string;
  kind: string;
  recipient_count: number;
  outcome: string;
  accepted_count: number | null;
  failed_count: number | null;
  completed: boolean;
}
const reminders = (column: 'application_id' | 'mentor_request_id', id: string) =>
  withDb((db) =>
    db.query<ReminderRow>(
      `SELECT id, kind, recipient_count, outcome, accepted_count, failed_count, completed_at IS NOT NULL AS completed
         FROM pending_reminders WHERE ${column} = $1`,
      [id],
    ),
  ).then((r) => r.rows);
const applicationReminders = (id: string) => reminders('application_id', id);
const requestReminders = (id: string) => reminders('mentor_request_id', id);

/** The reminder e-mails about one application (its link names it) or one mentor request (its unique field). */
const aboutApplication = (messages: EmailMessage[], applicationId: string) =>
  messages.filter((m) => m.subject === APPLICATION_SUBJECT && m.textBody.includes(`/hr/applications/${applicationId}`));
const aboutRequest = (messages: EmailMessage[], field: string) =>
  messages.filter((m) => m.subject === MENTOR_REQUEST_SUBJECT && m.textBody.includes(field));
const attemptsAbout = (mail: ReturnType<typeof smtp>, email: string) => mail.attempted.filter((to) => to === email);

/** An Admin, two HR users, an employee and a trainee with a Submitted application in a field of its own. */
async function people() {
  const admin = await signInStaff(api, 'Admin');
  const hrA = await signInStaff(api, 'HR');
  const hrB = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const trainee = await signInTrainee(api);
  const field = await newField(admin.client);
  const applicationId = await submitApplication(trainee.client, field.id, unique('Trainee'));
  return { admin, hrA, hrB, employee, trainee, field, applicationId };
}

/** As `people`, with the application accepted by HR A (its responsible HR) and a pending mentor request. */
async function pendingRequest() {
  const p = await people();
  expect((await p.hrA.client.post(`/api/hr/applications/${p.applicationId}/accept`)).status).toBe(200);
  const requestId = await mentorRequest(p.employee.client, p.applicationId);
  return { ...p, requestId };
}
async function mentorRequest(client: TestClient, applicationId: string) {
  const response = await client.post('/api/employee/mentor-requests', { applicationId, note: 'I can train them' });
  expect(response.status).toBe(201);
  return (await body<{ id: string }>(response)).id;
}

describe('eligibility rules (pure)', () => {
  it('overdue once N × 24 hours of actual time have elapsed: not before, due at and after the boundary', () => {
    const start = new Date('2027-03-20T10:00:00Z');
    expect(isOverdue(start, new Date(start.getTime() + 5 * DAY - 1), 5)).toBe(false);
    expect(isOverdue(start, new Date(start.getTime() + 5 * DAY), 5)).toBe(true);
    expect(isOverdue(start, new Date(start.getTime() + 5 * DAY + 1), 5)).toBe(true);
    // Elapsed time, not calendar days: across the spring daylight-saving change it is still 5 × 24 h.
    expect(isOverdue(start, new Date('2027-03-25T09:59:59.999Z'), 5)).toBe(false);
    expect(isOverdue(start, new Date(start.getTime() + 7 * DAY), 7)).toBe(true);
  });

  it('the check is 09:00 Asia/Hebron: 07:00 UTC in winter (UTC+2), 06:00 UTC in summer (UTC+3)', () => {
    expect(officialHour(new Date('2027-01-15T07:00:00Z'))).toBe(9);
    expect(isPendingReminderRun(new Date('2027-01-15T07:00:00Z'))).toBe(true);
    expect(isPendingReminderRun(new Date('2027-01-15T06:00:00Z'))).toBe(false); // 08:00 local
    expect(isPendingReminderRun(new Date('2027-07-15T06:00:00Z'))).toBe(true);
    expect(isPendingReminderRun(new Date('2027-07-15T07:00:00Z'))).toBe(false); // 10:00 local
  });

  it('on every day of the year, daylight-saving changes included, exactly one of the two UTC runs is at 09:xx local', () => {
    for (let day = 0; day < 366 * 2; day += 1) {
      const date = new Date(Date.UTC(2027, 0, 1) + day * DAY).toISOString().slice(0, 10);
      const runs = ['06', '07'].filter((h) => isPendingReminderRun(new Date(`${date}T${h}:00:00Z`)));
      expect(runs, date).toHaveLength(1);
    }
  });

  it('the bilingual templates: Arabic then English, HTML and text, the facts and the HR link, nothing else', () => {
    const application = renderEventEmail(
      {
        content: {
          kind: 'PendingApplicationReminder',
          applicationId: '0190aaaa-0000-7000-8000-000000000001',
          field: 'Full <stack>',
          applicantName: 'Sara',
          status: 'UnderReview',
          submittedDate: '2027-03-01',
          thresholdDays: 5,
        },
        entityId: '0190aaaa-0000-7000-8000-000000000001',
        recipient: { type: 'Employee', id: 'x', email: 'hr@company.example' },
      },
      'https://ims.example/',
    );
    expect(application.subject).toBe(APPLICATION_SUBJECT);
    expect(application.to).toBe('hr@company.example');
    const text = application.textBody;
    expect(text.indexOf('ينتظر طلب تدريب')).toBeLessThan(text.indexOf('A training application has been waiting'));
    for (const fact of ['Sara', 'Full <stack>', 'قيد المراجعة', 'Under review', '2027-03-01', '5 أيام', '5 days']) {
      expect(text).toContain(fact);
    }
    expect(text).toContain('https://ims.example/hr/applications/0190aaaa-0000-7000-8000-000000000001');
    expect(application.htmlBody).toContain('Full &lt;stack&gt;');
    expect(application.htmlBody).not.toContain('Full <stack>');

    const request = renderEventEmail(
      {
        content: {
          kind: 'PendingMentorRequestReminder',
          field: 'Data',
          traineeName: null,
          employeeName: 'Omar',
          requestedDate: '2027-03-02',
          thresholdDays: 7,
        },
        entityId: 'r',
        recipient: { type: 'Employee', id: 'x', email: 'hr@company.example' },
      },
      'https://ims.example',
    );
    expect(request.subject).toBe(MENTOR_REQUEST_SUBJECT);
    expect(request.textBody.indexOf('الموظف:')).toBeLessThan(request.textBody.indexOf('Employee:'));
    for (const fact of ['Omar', 'Data', '2027-03-02', '7 days', 'https://ims.example/hr/mentor-requests']) {
      expect(request.textBody).toContain(fact);
    }
    expect(request.textBody).not.toContain('Trainee:'); // no name recorded: the line is left out
    expect(request.htmlBody).toContain('dir="rtl"');
  });
});

describe('pending training applications (to every HR user)', () => {
  it('a Submitted application overdue: one e-mail to each HR user, none to the Admin, an employee or the trainee', async () => {
    const p = await people();
    await backdate('training_applications', p.applicationId, ago(30 * DAY));
    // Other test files promote and demote staff in parallel, so the HR population is observed on both sides of the run:
    // whoever is HR before and after must have been HR at the check and must get exactly one e-mail; nobody who was not
    // HR at either observation may get one.
    const hrEmails = () => withDb((db) => db.query<{ email: string }>(HR_SQL)).then((r) => r.rows.map((u) => u.email));
    const hrBefore = await hrEmails();

    const { mail } = await run();
    const hrAfter = await hrEmails();

    const mine = aboutApplication(mail.accepted, p.applicationId);
    const [row] = await applicationReminders(p.applicationId);
    expect(row).toMatchObject({ kind: 'TrainingApplication', outcome: 'Accepted', failed_count: 0, completed: true });
    expect(mine).toHaveLength(row!.recipient_count);
    expect(row!.accepted_count).toBe(row!.recipient_count);
    const to = mine.map((m) => m.to);
    expect(new Set(to).size).toBe(to.length); // one each
    expect(to).toEqual(expect.arrayContaining([p.hrA.email, p.hrB.email]));
    for (const email of hrBefore.filter((e) => hrAfter.includes(e))) expect(to).toContain(email);
    for (const email of to) expect([...hrBefore, ...hrAfter]).toContain(email);
    for (const email of [p.admin.email, p.employee.email, p.trainee.email]) expect(to).not.toContain(email);
    expect(mine[0]!.textBody).toContain(p.field.name);
    expect(mine[0]!.textBody).toContain('مُقدَّم');
  });

  it('Under Review counts from submitted_at (the review does not restart it); Accepted and Rejected are never reminded', async () => {
    const reviewed = await people();
    await backdate('training_applications', reviewed.applicationId, ago(10 * DAY));
    expect((await reviewed.hrA.client.post(`/api/hr/applications/${reviewed.applicationId}/review`)).status).toBe(200);
    const acceptedApp = await people();
    await backdate('training_applications', acceptedApp.applicationId, ago(30 * DAY));
    expect((await acceptedApp.hrA.client.post(`/api/hr/applications/${acceptedApp.applicationId}/accept`)).status).toBe(
      200,
    );
    const rejectedApp = await people();
    await backdate('training_applications', rejectedApp.applicationId, ago(30 * DAY));
    expect(
      (await rejectedApp.hrA.client.post(`/api/hr/applications/${rejectedApp.applicationId}/reject`, { reason: 'No' }))
        .status,
    ).toBe(200);

    const { mail } = await run({ alertDays: 5 });

    expect(aboutApplication(mail.accepted, reviewed.applicationId).map((m) => m.to)).toContain(reviewed.hrA.email);
    expect(aboutApplication(mail.accepted, reviewed.applicationId)[0]!.textBody).toContain('Under review');
    expect(await applicationReminders(reviewed.applicationId)).toHaveLength(1);
    for (const id of [acceptedApp.applicationId, rejectedApp.applicationId]) {
      expect(aboutApplication(mail.accepted, id)).toEqual([]);
      expect(await applicationReminders(id)).toEqual([]);
    }
  });

  it('the boundary: not before N × 24 h, due at exactly N × 24 h after submitted_at', async () => {
    const p = await people();
    const submitted = ago(6 * DAY);
    await backdate('training_applications', p.applicationId, submitted);

    const before = await run({ alertDays: 6, now: new Date(submitted.getTime() + 6 * DAY - 1) });
    expect(before.summary!.thresholdDays).toBe(6);
    expect(aboutApplication(before.mail.accepted, p.applicationId)).toEqual([]);
    expect(await applicationReminders(p.applicationId)).toEqual([]);

    const at = await run({ alertDays: 6, now: new Date(submitted.getTime() + 6 * DAY) });
    expect(aboutApplication(at.mail.accepted, p.applicationId).length).toBeGreaterThanOrEqual(2);
    expect(await applicationReminders(p.applicationId)).toHaveLength(1);
  });

  it('the threshold is read at each check, and a later change never sends a second reminder', async () => {
    const p = await people();
    await backdate('training_applications', p.applicationId, ago(6 * DAY));

    expect((await run({ alertDays: 7 })).mail.attempted.filter((to) => to === p.hrA.email).length).toBe(0);
    expect(await applicationReminders(p.applicationId)).toEqual([]);

    const lowered = await run({ alertDays: 5 }); // the Admin lowered it: now overdue
    expect(aboutApplication(lowered.mail.accepted, p.applicationId).map((m) => m.to)).toContain(p.hrA.email);
    expect(aboutApplication(lowered.mail.accepted, p.applicationId)[0]!.textBody).toContain('5 days');

    for (const alertDays of [1, 3, 30]) {
      const again = await run({ alertDays });
      expect(aboutApplication(again.mail.accepted, p.applicationId), String(alertDays)).toEqual([]);
    }
    expect(await applicationReminders(p.applicationId)).toHaveLength(1);
  });

  it('the real setting is the Admin setting pending_request_alert_days', async () => {
    const admin = await signInStaff(api, 'Admin');
    const settings = await body<{ pendingRequestAlertDays: number }>(
      await admin.client.get('/api/admin/settings/notifications'),
    );
    const db = new Database((env as unknown as Bindings).DATABASE_URL!);
    try {
      expect(await pendingRequestAlertDays(db)).toBe(settings.pendingRequestAlertDays);
    } finally {
      await db.close();
    }
  });

  it('an application decided before the check gets no reminder', async () => {
    const p = await people();
    await backdate('training_applications', p.applicationId, ago(30 * DAY));
    expect((await p.hrA.client.post(`/api/hr/applications/${p.applicationId}/accept`)).status).toBe(200);
    const { mail } = await run();
    expect(aboutApplication(mail.accepted, p.applicationId)).toEqual([]);
    expect(await applicationReminders(p.applicationId)).toEqual([]);
  });

  it('nobody holds the HR role: nothing sent or recorded; reminded once at a later check when HR exists', async () => {
    const p = await people();
    await backdate('training_applications', p.applicationId, ago(30 * DAY));

    const none = await run({ noHr: true });
    expect(none.mail.attempted).toEqual([]); // never redirected to anyone
    expect(none.summary!.noRecipient).toBeGreaterThanOrEqual(1);
    expect(await applicationReminders(p.applicationId)).toEqual([]);

    const later = await run();
    expect(aboutApplication(later.mail.accepted, p.applicationId).map((m) => m.to)).toContain(p.hrB.email);
    expect(await applicationReminders(p.applicationId)).toHaveLength(1);
    expect(aboutApplication((await run()).mail.accepted, p.applicationId)).toEqual([]);
  });
});

describe('pending mentor requests (to the current responsible HR only)', () => {
  it('a Pending request overdue from requested_at: one e-mail to the responsible HR only', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));

    const { mail } = await run();

    const mine = aboutRequest(mail.accepted, p.field.name);
    expect(mine.map((m) => m.to)).toEqual([p.hrA.email]);
    expect(mine[0]!.textBody).toContain('/hr/mentor-requests');
    for (const email of [p.hrB.email, p.admin.email, p.employee.email, p.trainee.email]) {
      expect(aboutRequest(mail.accepted, p.field.name).map((m) => m.to)).not.toContain(email);
    }
    expect(await requestReminders(p.requestId)).toEqual([
      expect.objectContaining({ kind: 'MentorRequest', recipient_count: 1, outcome: 'Accepted', accepted_count: 1 }),
    ]);
    // The application itself is Accepted: no application reminder.
    expect(await applicationReminders(p.applicationId)).toEqual([]);
  });

  it('a request not yet overdue (from requested_at, not the application) is not reminded', async () => {
    const p = await pendingRequest();
    await backdate('training_applications', p.applicationId, ago(60 * DAY));
    await backdate('mentor_requests', p.requestId, ago(1 * HOUR));
    const { mail } = await run({ alertDays: 5 });
    expect(aboutRequest(mail.accepted, p.field.name)).toEqual([]);
    expect(await requestReminders(p.requestId)).toEqual([]);
  });

  it('Approved, Rejected and AD-67 automatically rejected requests are never reminded', async () => {
    const approved = await pendingRequest();
    expect(
      (
        await approved.hrA.client.post(`/api/hr/mentor-requests/${approved.requestId}/approve`, {
          startDate: '2031-01-10',
          endDate: '2031-04-30',
        })
      ).status,
    ).toBe(200);
    const rejected = await pendingRequest();
    expect((await rejected.hrA.client.post(`/api/hr/mentor-requests/${rejected.requestId}/reject`)).status).toBe(200);
    const direct = await pendingRequest();
    const other = await signInStaff(api, 'Employee');
    expect(
      (
        await direct.hrA.client.post(`/api/hr/applications/${direct.applicationId}/direct-assignment`, {
          employeeId: other.user.id,
          startDate: '2031-01-10',
          endDate: '2031-04-30',
        })
      ).status,
    ).toBe(201);
    for (const p of [approved, rejected, direct]) await backdate('mentor_requests', p.requestId, ago(30 * DAY));

    const { mail } = await run();
    for (const p of [approved, rejected, direct]) {
      expect(aboutRequest(mail.accepted, p.field.name)).toEqual([]);
      expect(await requestReminders(p.requestId)).toEqual([]);
    }
  });

  it('a replaced responsible HR: only the new one is reminded, the former one never', async () => {
    const p = await pendingRequest();
    expect(
      (
        await p.admin.client.put(`/api/admin/accepted-trainees/${p.applicationId}/responsible-hr`, {
          hrId: p.hrB.user.id,
        })
      ).status,
    ).toBe(200);
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    const { mail } = await run();
    expect(aboutRequest(mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrB.email]);
  });

  it('the responsible HR lost the HR role: nobody else is reminded, nothing recorded; once a new one is appointed, once', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    await withDb((db) => db.query("UPDATE employees SET role = 'Employee' WHERE id = $1", [p.hrA.user.id]));

    const none = await run();
    expect(aboutRequest(none.mail.accepted, p.field.name)).toEqual([]);
    expect(attemptsAbout(none.mail, p.hrA.email)).toEqual([]);
    expect(await requestReminders(p.requestId)).toEqual([]);
    expect((await run()).mail.accepted.filter((m) => m.textBody.includes(p.field.name))).toEqual([]);

    expect(
      (
        await p.admin.client.put(`/api/admin/accepted-trainees/${p.applicationId}/responsible-hr`, {
          hrId: p.hrB.user.id,
        })
      ).status,
    ).toBe(200);
    const later = await run();
    expect(aboutRequest(later.mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrB.email]);
    expect(aboutRequest((await run()).mail.accepted, p.field.name)).toEqual([]);
    expect(await requestReminders(p.requestId)).toHaveLength(1);
  });
});

describe('exactly once, catch-up and concurrency', () => {
  it('repeated runs never remind a request twice; old and long-overdue requests are included (catch-up)', async () => {
    const p = await pendingRequest();
    const old = await people();
    await backdate('mentor_requests', p.requestId, ago(400 * DAY)); // "before the feature existed"
    await backdate('training_applications', old.applicationId, ago(200 * DAY));

    const first = await run();
    expect(aboutRequest(first.mail.accepted, p.field.name)).toHaveLength(1);
    expect(aboutApplication(first.mail.accepted, old.applicationId).length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 3; i += 1) {
      const again = await run({ now: new Date(Date.now() + i * HOUR) });
      expect(aboutRequest(again.mail.accepted, p.field.name)).toEqual([]);
      expect(aboutApplication(again.mail.accepted, old.applicationId)).toEqual([]);
    }
    expect(await requestReminders(p.requestId)).toHaveLength(1);
    expect(await applicationReminders(old.applicationId)).toHaveLength(1);
  });

  it('concurrent runs: one reminder row and one e-mail per recipient, whichever run claims it', async () => {
    const p = await pendingRequest();
    const app = await people();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    await backdate('training_applications', app.applicationId, ago(30 * DAY));
    const mail = smtp();

    await Promise.all([run({ mail }), run({ mail }), run({ mail })]);

    expect(aboutRequest(mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrA.email]);
    const [row] = await applicationReminders(app.applicationId);
    const appMails = aboutApplication(mail.accepted, app.applicationId);
    expect(appMails).toHaveLength(row!.recipient_count);
    expect(new Set(appMails.map((m) => m.to)).size).toBe(appMails.length);
    expect(await requestReminders(p.requestId)).toHaveLength(1);
  });

  it('the database refuses a second reminder for the same request, an empty one, and deletion', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    await run();
    const insert = (id: string, count: number) =>
      withDb((db) =>
        db.query(
          `INSERT INTO pending_reminders (id, kind, application_id, mentor_request_id, attempted_at, recipient_count, outcome)
           VALUES ($1, 'MentorRequest', NULL, $2, now(), $3, 'Attempting')`,
          [id, p.requestId, count],
        ),
      );
    await expect(insert(crypto.randomUUID(), 1)).rejects.toMatchObject({ code: '23505' }); // unique per request
    await expect(insert(crypto.randomUUID(), 0)).rejects.toMatchObject({ code: '23514' }); // at least one recipient
    await expect(
      withDb((db) => db.query('DELETE FROM pending_reminders WHERE mentor_request_id = $1', [p.requestId])),
    ).rejects.toThrow();
    expect(await requestReminders(p.requestId)).toHaveLength(1);
  });

  it('the claim and the outcome are audited as the System actor (by ims_app)', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    await run();
    const [row] = await requestReminders(p.requestId);
    const audit = await withDb((db) =>
      db.query<{ operation: string; actor_type: string; actor_id: string | null; database_user: string }>(
        `SELECT operation, actor_type, actor_id, database_user FROM audit_logs
          WHERE table_name = 'pending_reminders' AND entity_id = $1 ORDER BY id`,
        [row!.id],
      ),
    ).then((r) => r.rows);
    expect(audit).toEqual([
      { operation: 'INSERT', actor_type: 'System', actor_id: null, database_user: 'ims_app' },
      { operation: 'UPDATE', actor_type: 'System', actor_id: null, database_user: 'ims_app' },
    ]);
  });
});

describe('e-mail settings and SMTP failures', () => {
  it('EVENT_EMAILS disabled: nothing attempted or recorded; caught up once enabled, still once', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));

    const off = await run({ enabled: false });
    expect(off.summary).toBeNull();
    expect(off.mail.attempted).toEqual([]);
    expect(await requestReminders(p.requestId)).toEqual([]);

    const on = await run();
    expect(aboutRequest(on.mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrA.email]);
    expect(aboutRequest((await run()).mail.accepted, p.field.name)).toEqual([]);
  });

  it('SMTP failure: logged by kind and id only, recorded as Failed, never retried by a later run', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    const errors = vi.spyOn(console, 'error');

    const failing = smtp({ failFor: [p.hrA.email] });
    await run({ mail: failing });

    expect(attemptsAbout(failing, p.hrA.email)).toHaveLength(1); // one attempt, no retry
    expect(await requestReminders(p.requestId)).toEqual([
      expect.objectContaining({ outcome: 'Failed', accepted_count: 0, failed_count: 1, completed: true }),
    ]);
    const lines = errors.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes(p.requestId));
    expect(JSON.parse(line!)).toEqual({
      level: 'error',
      message: 'Event e-mail was not sent (no retry: delivery tracking is not built)',
      kind: 'PendingMentorRequestReminder',
      entityId: p.requestId,
    });
    for (const l of lines) expect(l).not.toContain(p.hrA.email);

    const later = smtp();
    await run({ mail: later });
    expect(attemptsAbout(later, p.hrA.email)).toEqual([]);
  });

  it('partial failure across HR recipients: the others still get it, the counts say which, nothing is resent', async () => {
    const p = await people();
    await backdate('training_applications', p.applicationId, ago(30 * DAY));
    const mail = smtp({ failFor: [p.hrB.email] });

    await run({ mail });

    const [row] = await applicationReminders(p.applicationId);
    expect(row).toMatchObject({ outcome: 'PartiallyAccepted', failed_count: 1, completed: true });
    expect(row!.accepted_count).toBe(row!.recipient_count - 1);
    expect(aboutApplication(mail.accepted, p.applicationId).map((m) => m.to)).toContain(p.hrA.email);
    expect(attemptsAbout(mail, p.hrB.email)).toHaveLength(1);
    const later = smtp();
    await run({ mail: later });
    expect(attemptsAbout(later, p.hrA.email)).toEqual([]);
    expect(attemptsAbout(later, p.hrB.email)).toEqual([]);
  });

  it('every e-mail failing: Failed with every count, and no in-app notification is ever written', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, ago(30 * DAY));
    // Every HR user gets an in-app "new application" notice whenever any test file submits one, so those are left out,
    // as in transfer.test.ts; every other notification of the recipient, and any about this request, must not change.
    const notifications = () =>
      withDb((db) =>
        db.query<{ n: number; about: number }>(
          `SELECT count(*) FILTER (WHERE recipient_id = $1 AND type <> 'ApplicationSubmitted')::int AS n,
                  count(*) FILTER (WHERE entity_id IN ($2, $3))::int AS about
             FROM notifications`,
          [p.hrA.user.id, p.requestId, p.applicationId],
        ),
      ).then((r) => r.rows[0]!);
    const before = await notifications();
    await run({ mail: smtp({ failAll: true }) });
    expect((await requestReminders(p.requestId))[0]).toMatchObject({ outcome: 'Failed', failed_count: 1 });
    expect(await notifications()).toEqual(before);
  });
});

describe('the Cron Trigger (0 6,7 * * *) and the transfers trigger', () => {
  // Runs in 2020, with requests backdated to 2019: nothing else in the shared test database is that old, and no
  // transfer decision is due then, so these runs touch only this test's requests.
  const WINTER = { acts: new Date('2020-01-15T07:00:00Z'), idle: new Date('2020-01-15T06:00:00Z') }; // UTC+2
  const SUMMER = { acts: new Date('2020-07-15T06:00:00Z'), idle: new Date('2020-07-15T07:00:00Z') }; // UTC+3
  const LONG_AGO = new Date('2019-01-01T08:00:00Z');

  async function cron(expression: string, at: Date, options: { enabled?: boolean; activatedAt?: string } = {}) {
    const mail = smtp();
    const ctx = createExecutionContext();
    createScheduledHandler({ now: () => at, emailSender: () => mail.sender })(
      createScheduledController({ scheduledTime: at.getTime(), cron: expression }),
      {
        ...(env as unknown as Bindings),
        EVENT_EMAILS: options.enabled === false ? 'disabled' : 'enabled',
        PENDING_REMINDERS_ACTIVATED_AT: options.activatedAt ?? '2018-06-01T00:00:00Z',
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return mail;
  }

  it('acts only on the run at 09:00 Asia/Hebron, in winter (07:00 UTC) and summer (06:00 UTC)', async () => {
    for (const season of [WINTER, SUMMER]) {
      const p = await pendingRequest();
      await backdate('mentor_requests', p.requestId, LONG_AGO);

      expect((await cron(PENDING_REMINDER_CRON, season.idle)).attempted).toEqual([]);
      expect(await requestReminders(p.requestId)).toEqual([]);

      const mail = await cron(PENDING_REMINDER_CRON, season.acts);
      expect(aboutRequest(mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrA.email]);
      expect(await requestReminders(p.requestId)).toHaveLength(1);
      expect((await cron(PENDING_REMINDER_CRON, new Date(season.acts.getTime() + DAY))).attempted).not.toContain(
        p.hrA.email,
      );
    }
  });

  it('with EVENT_EMAILS disabled the trigger records nothing; the next enabled daily check catches up', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, LONG_AGO);
    expect((await cron(PENDING_REMINDER_CRON, WINTER.acts, { enabled: false })).attempted).toEqual([]);
    expect(await requestReminders(p.requestId)).toEqual([]);
    const mail = await cron(PENDING_REMINDER_CRON, new Date(WINTER.acts.getTime() + DAY));
    expect(aboutRequest(mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrA.email]);
  });

  it('the transfers trigger never sends reminders, the reminder trigger never runs transfers, an unknown one nothing', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, LONG_AGO);
    const logs = vi.spyOn(console, 'log');

    expect((await cron(TRANSFER_CRON, WINTER.acts)).attempted).toEqual([]);
    expect(await requestReminders(p.requestId)).toEqual([]);
    expect(logs.mock.calls.some((c) => String(c[0]).includes('Scheduled transfers run'))).toBe(true);

    logs.mockClear();
    expect((await cron('*/5 * * * *', WINTER.acts)).attempted).toEqual([]);
    expect(await requestReminders(p.requestId)).toEqual([]);

    await cron(PENDING_REMINDER_CRON, WINTER.acts);
    const lines = logs.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('Scheduled transfers run'))).toBe(false);
    expect(lines.some((l) => l.includes('Pending-request reminders run'))).toBe(true);
    expect(await requestReminders(p.requestId)).toHaveLength(1);
  });

  it('launch cutoff missing, empty or invalid: fails closed (nothing claimed or sent, logged); valid: runs', async () => {
    const p = await pendingRequest();
    await backdate('mentor_requests', p.requestId, LONG_AGO);
    const errors = vi.spyOn(console, 'error');
    const db = vi.spyOn(Database.prototype, 'query');
    // wrangler.jsonc ships it empty: the committed default is "off" until the release sets it.
    expect((env as unknown as Bindings).PENDING_REMINDERS_ACTIVATED_AT ?? '').toBe('');
    for (const activatedAt of [
      '',
      '   ',
      'not-a-date',
      '2018-06-01',
      '2018-06-01T00:00:00',
      '2018-06-01T02:00:00+02:00',
      '2018-02-30T00:00:00Z',
    ]) {
      expect((await cron(PENDING_REMINDER_CRON, WINTER.acts, { activatedAt })).attempted, activatedAt).toEqual([]);
    }
    expect(db).not.toHaveBeenCalled(); // not even the candidate query
    expect(await requestReminders(p.requestId)).toEqual([]);
    expect(
      errors.mock.calls.filter((c) => String(c[0]).includes('PENDING_REMINDERS_ACTIVATED_AT is missing or invalid')),
    ).toHaveLength(7);

    db.mockRestore();
    const mail = await cron(PENDING_REMINDER_CRON, WINTER.acts, { activatedAt: '2018-06-01T00:00:00Z' });
    expect(aboutRequest(mail.accepted, p.field.name).map((m) => m.to)).toEqual([p.hrA.email]);
  });
});

describe('launch cutoff: only requests created at or after the first activation (AD-61 item 18)', () => {
  it('parses only an exact UTC timestamp; anything else is refused', () => {
    expect(parseActivationCutoff('2026-11-20T10:15:00Z')?.toISOString()).toBe('2026-11-20T10:15:00.000Z');
    expect(parseActivationCutoff(' 2026-11-20T10:15:00.123Z ')?.toISOString()).toBe('2026-11-20T10:15:00.123Z');
    for (const value of [
      undefined,
      null,
      '',
      '2026-11-20',
      '2026-11-20T10:15:00',
      '2026-11-20T10:15Z',
      '2026-11-20 10:15:00Z',
      '2026-11-20T12:15:00+02:00',
      '2026-02-30T00:00:00Z',
      '2026-11-20T24:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-11-20T10:15:00.1Z',
      'Fri, 20 Nov 2026 10:15:00 GMT',
    ]) {
      expect(parseActivationCutoff(value), String(value)).toBeNull();
    }
  });

  it('applications: before the cutoff never; exactly at it and after it, once overdue; the exact instant, not the day', async () => {
    const activatedAt = new Date(Date.now() - 20 * DAY);
    const before = await people();
    const at = await people();
    const after = await people();
    const sameDayEarlier = await people();
    await backdate('training_applications', before.applicationId, new Date(activatedAt.getTime() - 1));
    await backdate('training_applications', at.applicationId, activatedAt);
    await backdate('training_applications', after.applicationId, new Date(activatedAt.getTime() + HOUR));
    // Earlier on the same UTC day as the cutoff (or the day before when the cutoff is just after midnight).
    await backdate('training_applications', sameDayEarlier.applicationId, new Date(activatedAt.getTime() - 60_000));

    const { mail, summary } = await run({ activatedAt, alertDays: 5 });

    expect(summary!.activatedAt).toBe(activatedAt.toISOString());
    for (const p of [before, sameDayEarlier]) {
      expect(aboutApplication(mail.accepted, p.applicationId)).toEqual([]);
      expect(await applicationReminders(p.applicationId)).toEqual([]);
    }
    for (const p of [at, after]) {
      expect(aboutApplication(mail.accepted, p.applicationId).map((m) => m.to)).toContain(p.hrA.email);
      expect(await applicationReminders(p.applicationId)).toHaveLength(1);
    }
    // Never later either, whatever the threshold.
    for (const alertDays of [1, 5, 30]) {
      expect(aboutApplication((await run({ activatedAt, alertDays })).mail.accepted, before.applicationId)).toEqual([]);
    }
  });

  it('Under Review: an old application moved to review after the cutoff stays excluded; a new one is reminded', async () => {
    const activatedAt = new Date(Date.now() - 20 * DAY);
    const old = await people();
    const fresh = await people();
    await backdate('training_applications', old.applicationId, new Date(activatedAt.getTime() - DAY));
    await backdate('training_applications', fresh.applicationId, new Date(activatedAt.getTime() + 60_000));
    for (const p of [old, fresh]) {
      expect((await p.hrA.client.post(`/api/hr/applications/${p.applicationId}/review`)).status).toBe(200);
    }

    const { mail } = await run({ activatedAt, alertDays: 5 });

    expect(aboutApplication(mail.accepted, old.applicationId)).toEqual([]);
    expect(await applicationReminders(old.applicationId)).toEqual([]);
    expect(aboutApplication(mail.accepted, fresh.applicationId)[0]!.textBody).toContain('Under review');
  });

  it("mentor requests: by their own requested_at, never the application's submitted_at", async () => {
    const activatedAt = new Date(Date.now() - 20 * DAY);
    // An application from before the cutoff (accepted), with an old request and, on another, a new request.
    const oldRequest = await pendingRequest();
    const newRequest = await pendingRequest();
    await backdate('training_applications', oldRequest.applicationId, new Date(activatedAt.getTime() - 30 * DAY));
    await backdate('training_applications', newRequest.applicationId, new Date(activatedAt.getTime() - 30 * DAY));
    await backdate('mentor_requests', oldRequest.requestId, new Date(activatedAt.getTime() - 1));
    await backdate('mentor_requests', newRequest.requestId, activatedAt); // exactly at the cutoff

    const { mail } = await run({ activatedAt, alertDays: 5 });

    expect(aboutRequest(mail.accepted, oldRequest.field.name)).toEqual([]);
    expect(await requestReminders(oldRequest.requestId)).toEqual([]);
    expect(aboutRequest(mail.accepted, newRequest.field.name).map((m) => m.to)).toEqual([newRequest.hrA.email]);
    expect(await requestReminders(newRequest.requestId)).toHaveLength(1);
  });

  it('the claim re-checks the cutoff under the row lock: an old request in a stale candidate list is refused', async () => {
    const activatedAt = new Date(Date.now() - 20 * DAY);
    const app = await people();
    const request = await pendingRequest();
    await backdate('training_applications', app.applicationId, new Date(activatedAt.getTime() - DAY));
    await backdate('mentor_requests', request.requestId, new Date(activatedAt.getTime() - DAY));

    const { mail, summary } = await run({
      activatedAt,
      alertDays: 5,
      extraCandidates: [
        { kind: 'TrainingApplication', id: app.applicationId },
        { kind: 'MentorRequest', id: request.requestId },
      ],
    });

    expect(summary!.skipped).toBeGreaterThanOrEqual(2);
    expect(aboutApplication(mail.accepted, app.applicationId)).toEqual([]);
    expect(aboutRequest(mail.accepted, request.field.name)).toEqual([]);
    expect(await applicationReminders(app.applicationId)).toEqual([]);
    expect(await requestReminders(request.requestId)).toEqual([]);
  });

  it('no cutoff passed to the job: nothing read, claimed or sent', async () => {
    const p = await people();
    await backdate('training_applications', p.applicationId, ago(30 * DAY));
    const db = vi.spyOn(Database.prototype, 'query');
    for (const activatedAt of [null, new Date('invalid')]) {
      const { summary, mail } = await run({ activatedAt });
      expect(summary).toBeNull();
      expect(mail.attempted).toEqual([]);
    }
    expect(db).not.toHaveBeenCalled();
    db.mockRestore();
    expect(await applicationReminders(p.applicationId)).toEqual([]);
  });

  it('the cutoff is the configured one, never the run time; existing reminders are kept and never resent', async () => {
    const activatedAt = new Date(Date.now() - 20 * DAY);
    const p = await people();
    await backdate('training_applications', p.applicationId, new Date(activatedAt.getTime() + HOUR));
    const first = await run({ activatedAt, alertDays: 5 });
    expect(aboutApplication(first.mail.accepted, p.applicationId).length).toBeGreaterThanOrEqual(1);
    const [row] = await applicationReminders(p.applicationId);

    // Later runs ("after a restart or redeploy") with the same configured cutoff: the cutoff does not move with them.
    for (const now of [new Date(), new Date(Date.now() + 3 * DAY)]) {
      const again = await run({ activatedAt, alertDays: 5, now });
      expect(again.summary!.activatedAt).toBe(activatedAt.toISOString());
      expect(aboutApplication(again.mail.accepted, p.applicationId)).toEqual([]);
    }
    // Even a later cutoff never touches or resends an existing reminder.
    await run({ activatedAt: new Date(), alertDays: 5 });
    expect(await applicationReminders(p.applicationId)).toEqual([row]);
  });
});
