import { env } from 'cloudflare:test';
import type { Context } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import wranglerConfig from '../wrangler.jsonc?raw';
import { loadSettings, type Bindings } from '../src/config';
import type { AppEnv } from '../src/context';
import { EmailSendError } from '../src/domain/errors';
import type { EmailMessage, EmailSender } from '../src/email';
import { escapeHtml } from '../src/emailTemplate';
import {
  BLOCKED_EVENT_EMAILS,
  renderEventEmail,
  sendEventEmails,
  type EventEmail,
  type EventEmailContent,
} from '../src/features/notifications/eventEmails';
import { body, createTestApi, signInStaff, signInTrainee, type TestApi, unique, withDb } from './helpers';
import { submitApplication } from './seed';

/**
 * Event e-mails of PDF §7 whose workflows exist (AD-59, AD-60, AD-61), sent best effort after the business commit, and
 * only with EVENT_EMAILS=enabled. Every transport here is a fake: no test reaches a mail server.
 */
const ENABLED: Partial<Bindings> = { EVENT_EMAILS: 'enabled' };
const SIGN_IN_SUBJECT = 'رمز الدخول / Sign-in code';
const HOSTILE = `<script>alert("x")</script> & 'q'`;

afterEach(() => vi.restoreAllMocks());

/** Event e-mails (not sign-in codes) sent to `to`. */
const eventEmailsTo = (api: TestApi, to: string) =>
  api.emails.sent.filter((m) => m.to === to && !m.subject.startsWith(SIGN_IN_SUBJECT));
const allEventEmails = (api: TestApi) => api.emails.sent.filter((m) => !m.subject.startsWith(SIGN_IN_SUBJECT));

/** The HTML's text with tags removed and the escaped characters restored. */
const htmlText = (html: string) =>
  html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Arabic first, then English, in the subject, the plain text and the HTML; every text line also in the HTML. */
function expectBilingual(message: EmailMessage, arHeading: string, enHeading: string) {
  expect(message.subject).toBe(`${arHeading} / ${enHeading}`);
  expect(message.textBody.indexOf(arHeading)).toBe(0);
  expect(message.textBody.indexOf(enHeading)).toBeGreaterThan(message.textBody.indexOf(arHeading));
  const ar = message.htmlBody.indexOf('<div dir="rtl" lang="ar"');
  const en = message.htmlBody.indexOf('<div dir="ltr" lang="en"');
  expect(ar).toBeGreaterThan(0);
  expect(en).toBeGreaterThan(ar);
  // Each heading inside its own block (the <title> before both holds the subject).
  const arHeadingAt = message.htmlBody.indexOf(escapeHtml(arHeading), ar);
  expect(arHeadingAt).toBeGreaterThan(ar);
  expect(arHeadingAt).toBeLessThan(en);
  expect(message.htmlBody.indexOf(escapeHtml(enHeading), en)).toBeGreaterThan(en);
  const visible = htmlText(message.htmlBody);
  for (const line of message.textBody.split('\n').filter((l) => l !== '' && l !== '—')) {
    // A detail line is "label value" in the text; in the HTML the label and the value are separate elements.
    for (const part of line.includes(': ') ? line.split(/(?<=:) /) : [line]) {
      for (const piece of part.split('\n')) expect(visible).toContain(piece);
    }
  }
  expect(message.htmlBody).not.toMatch(/<(img|script|iframe|form|link)\b/i);
}

/** Admin with a field whose name needs escaping, HR, an employee. */
async function cast(api: TestApi) {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const name = `${unique('Field')} ${HOSTILE}`;
  const field = await body<{ id: string; name: string }>(
    await admin.client.post('/api/admin/fields', { name, description: null }),
  );
  expect(field.name).toBe(name);
  return { admin, hr, employee, field };
}

describe('event e-mails enabled: the six events whose recipients are decided', () => {
  const api = createTestApi({}, ENABLED);

  it('application received, then accepted: one e-mail each, to the trainee only, in both languages', async () => {
    const { hr, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);

    const received = eventEmailsTo(api, trainee.email);
    expect(received).toHaveLength(1);
    expectBilingual(received[0]!, 'تم استلام طلب التدريب', 'Training application received');
    expect(received[0]!.textBody).toContain(`المجال: ${field.name}`);
    expect(received[0]!.textBody).toContain(`Field: ${field.name}`);
    expect(received[0]!.htmlBody).toContain(escapeHtml(field.name));
    expect(received[0]!.htmlBody).not.toContain('<script>');
    expect(received[0]!.textBody).toContain('http://localhost:4200/trainee');

    // "New training application" to HR is blocked (NEW-24): nothing to HR.
    expect(eventEmailsTo(api, hr.email)).toEqual([]);

    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    const accepted = eventEmailsTo(api, trainee.email);
    expect(accepted).toHaveLength(2);
    expectBilingual(accepted[1]!, 'تم قبول طلب التدريب', 'Training application accepted');
  });

  it('application rejected: the trainee gets the stored reason in both languages, as text and escaped HTML', async () => {
    const { hr, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);
    const reason = `${HOSTILE}\nالفترة ممتلئة / The period is full`;
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/reject`, { reason })).status).toBe(200);

    const [, rejected] = eventEmailsTo(api, trainee.email);
    expectBilingual(rejected!, 'لم يتم قبول طلب التدريب', 'Training application not accepted');
    expect(rejected!.textBody).toContain(`سبب الرفض: ${reason}`);
    expect(rejected!.textBody).toContain(`Rejection reason: ${reason}`);
    expect(rejected!.htmlBody.split(escapeHtml(reason))).toHaveLength(3); // in the Arabic and the English part
    expect(rejected!.htmlBody).not.toContain('<script>');
    const stored = await withDb((db) =>
      db.query<{ rejection_reason: string }>('SELECT rejection_reason FROM training_applications WHERE id = $1', [
        applicationId,
      ]),
    );
    expect(stored.rows[0]!.rejection_reason).toBe(reason);
  });

  it('mentor request approved: the employee is told, and the trainee gets the start date without mentor details', async () => {
    const { hr, employee, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id, 'Lina Haddad');
    await hr.client.post(`/api/hr/applications/${applicationId}/accept`);
    const requested = await employee.client.post('/api/employee/mentor-requests', {
      applicationId,
      note: 'I can mentor this trainee.',
    });
    expect(requested.status).toBe(201);
    const requestId = (await body<{ id: string }>(requested)).id;
    expect(eventEmailsTo(api, hr.email)).toEqual([]); // "employee asked to train a trainee" to HR: blocked (NEW-24)

    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const approved = await hr.client.post(`/api/hr/mentor-requests/${requestId}/approve`, {
      startDate: '2031-02-01',
      endDate: '2031-04-30',
    });
    expect(approved.status).toBe(200);

    // One success line per e-mail: kind and record id only (a log line, not a delivery record).
    const successes = logged
      .filter((line) => line.includes('Event e-mail sent'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(successes).toEqual([
      {
        level: 'info',
        message: 'Event e-mail sent (log line only, no delivery record)',
        kind: 'MentorRequestApproved',
        entityId: requestId,
      },
      {
        level: 'info',
        message: 'Event e-mail sent (log line only, no delivery record)',
        kind: 'AssignmentApproved',
        entityId: requestId,
      },
    ]);
    const lines = logged.join('\n');
    for (const secret of [employee.email, trainee.email, field.name, 'Lina Haddad', '2031-02-01', 'http'])
      expect(lines).not.toContain(secret);

    const toEmployee = eventEmailsTo(api, employee.email);
    expect(toEmployee).toHaveLength(1);
    expectBilingual(toEmployee[0]!, 'تمت الموافقة على طلب التدريب', 'Training request approved');
    expect(toEmployee[0]!.textBody).toContain('Trainee: Lina Haddad');
    expect(toEmployee[0]!.textBody).toContain('http://localhost:4200/employee/trainees');

    const toTrainee = eventEmailsTo(api, trainee.email).at(-1)!;
    expectBilingual(toTrainee, 'تم اعتماد ربطك بمدرّب', 'Your mentor assignment has been approved');
    expect(toTrainee.textBody).toContain('تاريخ البداية: 2031-02-01');
    expect(toTrainee.textBody).toContain('Start date: 2031-02-01');
    expect(toTrainee.textBody).toContain('اعتمدت الموارد البشرية ربطك بمدرّب لتدريبك، وحدّدت تاريخ بدايته.');
    expect(toTrainee.textBody).toContain(
      'HR has approved your assignment to a mentor for your training and set its start date.',
    );
    // About the mentor assignment, not the application decision (which has its own e-mail).
    expect(toTrainee.subject).toBe('تم اعتماد ربطك بمدرّب / Your mentor assignment has been approved');
    expect(toTrainee.subject).not.toMatch(/application|طلب/i);
    // NEW-30: no mentor details (name or contact) until the owner decides.
    for (const mentor of [employee.email, employee.user.email]) expect(toTrainee.textBody).not.toContain(mentor);
    expect(toTrainee.textBody).not.toContain('2031-04-30'); // only the start details
  });

  it('mentor request rejected: the employee is told; the trainee and HR are not', async () => {
    const { hr, employee, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);
    await hr.client.post(`/api/hr/applications/${applicationId}/accept`);
    const requestId = (
      await body<{ id: string }>(
        await employee.client.post('/api/employee/mentor-requests', { applicationId, note: 'Request' }),
      )
    ).id;
    const before = eventEmailsTo(api, trainee.email).length;
    expect((await hr.client.post(`/api/hr/mentor-requests/${requestId}/reject`)).status).toBe(200);

    const [rejected] = eventEmailsTo(api, employee.email);
    expectBilingual(rejected!, 'لم تتم الموافقة على طلب التدريب', 'Training request not approved');
    expect(eventEmailsTo(api, trainee.email)).toHaveLength(before);
    expect(eventEmailsTo(api, hr.email)).toEqual([]);
  });

  it('a repeated or unauthorised decision sends nothing more: no duplicate business event, no duplicate e-mail', async () => {
    const { hr, employee, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);

    expect((await employee.client.post(`/api/hr/applications/${applicationId}/reject`, { reason: 'x' })).status).toBe(
      403,
    );
    expect((await trainee.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(403);
    expect(eventEmailsTo(api, trainee.email)).toHaveLength(1); // the "received" e-mail only

    expect((await hr.client.post(`/api/hr/applications/${applicationId}/reject`, { reason: 'Full' })).status).toBe(200);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/reject`, { reason: 'Full' })).status).toBe(400);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(400);
    expect(eventEmailsTo(api, trainee.email).map((m) => m.subject)).toEqual([
      'تم استلام طلب التدريب / Training application received',
      'لم يتم قبول طلب التدريب / Training application not accepted',
    ]);
  });
});

describe('event e-mails disabled (the default, also in wrangler.jsonc)', () => {
  it('the same workflows send no event e-mail at all', async () => {
    const api = createTestApi(); // test configuration without EVENT_EMAILS, like wrangler.jsonc's "disabled"
    const { hr, employee, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const accepted = await submitApplication(trainee.client, field.id);
    const rejected = await submitApplication(trainee.client, field.id);
    await hr.client.post(`/api/hr/applications/${accepted}/accept`);
    await hr.client.post(`/api/hr/applications/${rejected}/reject`, { reason: 'Full' });
    const requestId = (
      await body<{ id: string }>(
        await employee.client.post('/api/employee/mentor-requests', { applicationId: accepted, note: 'Request' }),
      )
    ).id;
    await hr.client.post(`/api/hr/mentor-requests/${requestId}/approve`, {
      startDate: '2031-02-01',
      endDate: '2031-04-30',
    });
    expect(allEventEmails(api)).toEqual([]);
  });

  it('is off unless EVENT_EMAILS is exactly enabled; wrangler.jsonc says disabled; anything else stops the API', () => {
    const base: Bindings = {
      ENVIRONMENT: 'development',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db?sslmode=disable',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
    };
    expect(loadSettings(base).eventEmails).toBe(false);
    expect(loadSettings({ ...base, EVENT_EMAILS: '' }).eventEmails).toBe(false);
    expect(loadSettings({ ...base, EVENT_EMAILS: 'disabled' }).eventEmails).toBe(false);
    expect(loadSettings({ ...base, EVENT_EMAILS: 'enabled' }).eventEmails).toBe(true);
    expect(() => loadSettings({ ...base, EVENT_EMAILS: 'yes' })).toThrow(/EVENT_EMAILS/);
    expect(wranglerConfig).toMatch(/"EVENT_EMAILS":\s*"disabled"/);
    expect(loadSettings(env as unknown as Bindings).eventEmails).toBe(false); // the test configuration
  });
});

describe('a failed event e-mail never changes the business operation', () => {
  /** Captures sign-in codes (so trainees can sign in) and fails every other e-mail, like an SMTP outage. */
  class FailingEventSender implements EmailSender {
    readonly sent: EmailMessage[] = [];
    attempts = 0;
    async send(message: EmailMessage) {
      if (message.subject.startsWith(SIGN_IN_SUBJECT)) {
        this.sent.push(message);
        return;
      }
      this.attempts++;
      throw new EmailSendError();
    }
    lastSignInFor(to: string) {
      const text = this.sent.findLast((m) => m.to === to)!.textBody;
      return { code: /code: (\d{6})/.exec(text)![1]!, token: '' };
    }
  }

  it('reject succeeds and is stored; the failure is logged by kind and record, without recipient or reason', async () => {
    const failing = new FailingEventSender();
    const api = createTestApi({ emailSender: () => failing }, ENABLED);
    Object.assign(api.emails, { lastSignInFor: (to: string) => failing.lastSignInFor(to) });
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const loggedInfo: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(
      (...args: unknown[]) => void loggedInfo.push(args.map(String).join(' ')),
    );

    const { hr, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id); // its "received" e-mail fails too
    const reason = unique('Private reason');
    const response = await hr.client.post(`/api/hr/applications/${applicationId}/reject`, { reason });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id: applicationId, status: 'Rejected', rejectionReason: reason });
    expect(failing.attempts).toBe(2);
    expect(loggedInfo.filter((line) => line.includes('Event e-mail sent'))).toEqual([]);

    const stored = await withDb((db) =>
      db.query<{ status: string }>('SELECT status FROM training_applications WHERE id = $1', [applicationId]),
    );
    expect(stored.rows[0]!.status).toBe('Rejected');
    const logs = logged.join('\n');
    expect(logs).toContain('"kind":"ApplicationRejected"');
    expect(logs).toContain(applicationId);
    for (const secret of [trainee.email, reason, field.name]) expect(logs).not.toContain(secret);
  });
});

describe('sendEventEmails (the only delivery point; Phase 3 replaces it)', () => {
  const event = (content: EventEmailContent): EventEmail => ({
    content,
    entityId: crypto.randomUUID(),
    recipient: { type: 'Employee', id: crypto.randomUUID(), email: 'hr@company.example' },
  });

  function fakeContext(load: EmailMessage[], enabled = true) {
    const waits: Promise<unknown>[] = [];
    const c = {
      var: {
        traceId: 't',
        db: {},
        settings: { eventEmails: enabled, trainee: { signInLinkBaseUrl: 'https://ims.example' } },
        deps: { emailSender: () => ({ send: async (m: EmailMessage) => void load.push(m) }) },
      },
      executionCtx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) },
    } as unknown as Context<AppEnv>;
    return { c, done: () => Promise.all(waits) };
  }

  it('never sends the HR events blocked by NEW-24, never loads anything when disabled, and survives a loading error', async () => {
    expect(BLOCKED_EVENT_EMAILS).toEqual({ ApplicationSubmitted: 'NEW-24', MentorRequestSubmitted: 'NEW-24' });
    const sent: EmailMessage[] = [];
    const enabled = fakeContext(sent);
    await sendEventEmails(enabled.c, async () => [
      event({ kind: 'ApplicationSubmitted', applicationId: crypto.randomUUID(), field: 'F', applicantName: 'A' }),
      event({ kind: 'MentorRequestSubmitted', field: 'F', traineeName: 'T', employeeName: 'E' }),
    ]);
    await enabled.done();
    expect(sent).toEqual([]);

    const load = vi.fn(async () => [] as EventEmail[]);
    await sendEventEmails(fakeContext(sent, false).c, load);
    expect(load).not.toHaveBeenCalled();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      sendEventEmails(enabled.c, async () => {
        throw new Error('database unavailable');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('templates of all eight events (including the two blocked HR events)', () => {
  const SITE = 'https://ims.example/';
  const cases: [EventEmailContent, string, string, string][] = [
    [
      { kind: 'ApplicationSubmitted', applicationId: 'a1', field: HOSTILE, applicantName: HOSTILE },
      'طلب تدريب جديد',
      'New training application',
      'https://ims.example/hr/applications/a1',
    ],
    [
      { kind: 'ApplicationReceived', field: HOSTILE },
      'تم استلام طلب التدريب',
      'Training application received',
      'https://ims.example/trainee',
    ],
    [
      { kind: 'ApplicationAccepted', field: HOSTILE },
      'تم قبول طلب التدريب',
      'Training application accepted',
      'https://ims.example/trainee',
    ],
    [
      { kind: 'ApplicationRejected', field: HOSTILE, reason: `${HOSTILE}\nline 2` },
      'لم يتم قبول طلب التدريب',
      'Training application not accepted',
      'https://ims.example/trainee',
    ],
    [
      { kind: 'MentorRequestSubmitted', field: HOSTILE, traineeName: HOSTILE, employeeName: HOSTILE },
      'طلب تدريب متدرب',
      'Request to train a trainee',
      'https://ims.example/hr/mentor-requests',
    ],
    [
      { kind: 'MentorRequestApproved', field: HOSTILE, traineeName: HOSTILE },
      'تمت الموافقة على طلب التدريب',
      'Training request approved',
      'https://ims.example/employee/trainees',
    ],
    [
      { kind: 'MentorRequestRejected', field: HOSTILE, traineeName: null },
      'لم تتم الموافقة على طلب التدريب',
      'Training request not approved',
      'https://ims.example/employee/available',
    ],
    [
      { kind: 'AssignmentApproved', field: HOSTILE, startDate: '2031-02-01' },
      'تم اعتماد ربطك بمدرّب',
      'Your mentor assignment has been approved',
      'https://ims.example/trainee',
    ],
  ];

  it.each(cases)('%o: bilingual, equivalent text and HTML, escaped, only the IMS link', (content, ar, en, link) => {
    const message = renderEventEmail(
      { content, entityId: 'e', recipient: { type: 'Trainee', id: 't', email: 'x@uni.example' } },
      SITE,
    );
    expect(message.to).toBe('x@uni.example');
    expectBilingual(message, ar, en);
    expect(message.htmlBody).not.toContain('<script>');
    expect(message.htmlBody).toContain(escapeHtml(HOSTILE));
    expect(new Set(message.htmlBody.match(/https?:\/\/[^"<\s]+/g))).toEqual(new Set([link]));
    expect(message.textBody.match(/https?:\/\/\S+/g)).toEqual([link, link]); // once per language
  });

  it('omits a missing name instead of printing an empty value', () => {
    const message = renderEventEmail(
      {
        content: { kind: 'MentorRequestRejected', field: 'Backend', traineeName: null },
        entityId: 'e',
        recipient: { type: 'Employee', id: 'x', email: 'e@company.example' },
      },
      SITE,
    );
    expect(message.textBody).not.toContain('Trainee:');
    expect(message.textBody).not.toContain('المتدرب:');
    expect(message.textBody).toContain('Field: Backend');
  });
});
