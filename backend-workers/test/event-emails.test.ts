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
  applicationSubmittedEmails,
  renderEventEmail,
  sendEventEmails,
  type EventEmail,
  type EventEmailContent,
} from '../src/features/notifications/eventEmails';
import { body, createTestApi, setRole, signInStaff, signInTrainee, type TestApi, unique, withDb } from './helpers';
import { submitApplication } from './seed';

/**
 * Event e-mails of PDF §7 whose workflows exist (AD-59, AD-60, AD-61; HR recipients NEW-24; mentor details NEW-30), sent
 * best effort after the business commit, and only with EVENT_EMAILS=enabled. Every transport here is a fake: no test
 * reaches a mail server.
 */
const ENABLED: Partial<Bindings> = { EVENT_EMAILS: 'enabled' };
const SIGN_IN_SUBJECT = 'رمز الدخول / Sign-in code';
const HOSTILE = `<script>alert("x")</script> & 'q'`;

afterEach(() => vi.restoreAllMocks());

/** Event e-mails (not sign-in codes) sent to `to`. */
const eventEmailsTo = (api: TestApi, to: string) =>
  api.emails.sent.filter((m) => m.to === to && !m.subject.startsWith(SIGN_IN_SUBJECT));
const allEventEmails = (api: TestApi) => api.emails.sent.filter((m) => !m.subject.startsWith(SIGN_IN_SUBJECT));
const NEW_APPLICATION = 'طلب تدريب جديد / New training application';
const NEW_MENTOR_REQUEST = 'طلب تدريب متدرب / Request to train a trainee';
/** The HR e-mails of one event: by subject and a text that identifies the record. */
const hrEmailsAbout = (api: TestApi, subject: string, marker: string) =>
  api.emails.sent.filter((m) => m.subject === subject && m.textBody.includes(marker));

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

describe('event e-mails enabled: all eight events', () => {
  const api = createTestApi({}, ENABLED);

  it('application submitted: received to the trainee and one e-mail to each HR user; then accepted to the trainee', async () => {
    const { admin, hr, employee, field } = await cast(api);
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

    // "New training application" to every HR user (NEW-24), one separate e-mail each, never to non-HR accounts.
    const toHr = hrEmailsAbout(api, NEW_APPLICATION, `/hr/applications/${applicationId}`);
    expect(toHr.filter((m) => m.to === hr.email)).toHaveLength(1);
    expect(new Set(toHr.map((m) => m.to)).size).toBe(toHr.length); // no duplicate recipient
    for (const m of toHr) expect(m.to).not.toMatch(/[,;\s]/); // one address per message, never a shared one
    expectBilingual(toHr[0]!, 'طلب تدريب جديد', 'New training application');
    expect(toHr[0]!.textBody).toContain('Applicant: Report Trainee');
    for (const nonHr of [trainee.email]) expect(toHr.map((m) => m.to)).not.toContain(nonHr);

    expect(toHr.map((m) => m.to)).not.toContain(admin.email);
    expect(toHr.map((m) => m.to)).not.toContain(employee.email);

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

  it('mentor request: HR is told; approved: the employee is told, and the trainee gets exactly the NEW-30 details', async () => {
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
    const mentorName = (
      await withDb((db) =>
        db.query<{ full_name: string }>('SELECT full_name FROM employees WHERE id = $1', [employee.user.id]),
      )
    ).rows[0]!.full_name;
    // "An employee asked to train a trainee" to every HR user (NEW-24), never to the employee or the trainee.
    const toHr = hrEmailsAbout(api, NEW_MENTOR_REQUEST, 'Trainee: Lina Haddad').filter((m) =>
      m.textBody.includes(`Field: ${field.name}`),
    );
    expect(toHr.filter((m) => m.to === hr.email)).toHaveLength(1);
    expect(new Set(toHr.map((m) => m.to)).size).toBe(toHr.length);
    expect(toHr.map((m) => m.to)).not.toContain(employee.email);
    expect(toHr.map((m) => m.to)).not.toContain(trainee.email);
    expectBilingual(toHr[0]!, 'طلب تدريب متدرب', 'Request to train a trainee');
    expect(toHr[0]!.textBody).toContain(`Employee: ${mentorName}`);

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
    expect(toEmployee[0]!.textBody).not.toContain('Mentor'); // mentor details only in the trainee's assignment e-mail

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
    // NEW-30, exactly: field, start date, the mentor's name and registered work e-mail; no end date, nothing else.
    expect(toTrainee.textBody).toBe(
      [
        'تم اعتماد ربطك بمدرّب',
        '',
        'اعتمدت الموارد البشرية ربطك بمدرّب لتدريبك، وحدّدت تاريخ بدايته.',
        `المجال: ${field.name}`,
        'تاريخ البداية: 2031-02-01',
        `المدرّب: ${mentorName}`,
        `البريد الإلكتروني للمدرّب: ${employee.email}`,
        '',
        'لمتابعة طلبك:',
        'http://localhost:4200/trainee',
        '',
        '—',
        '',
        'Your mentor assignment has been approved',
        '',
        'HR has approved your assignment to a mentor for your training and set its start date.',
        `Field: ${field.name}`,
        'Start date: 2031-02-01',
        `Mentor: ${mentorName}`,
        `Mentor’s e-mail: ${employee.email}`,
        '',
        'To follow your application:',
        'http://localhost:4200/trainee',
      ].join('\n'),
    );
    expect(toTrainee.htmlBody).toContain(escapeHtml(employee.email));
    expect(toTrainee.textBody).not.toContain('2031-04-30'); // only the start details
  });

  it('mentor request rejected: the employee is told; the trainee is not, and HR gets nothing more', async () => {
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
    const hrBefore = eventEmailsTo(api, hr.email).length;
    expect((await hr.client.post(`/api/hr/mentor-requests/${requestId}/reject`)).status).toBe(200);

    const [rejected] = eventEmailsTo(api, employee.email);
    expectBilingual(rejected!, 'لم تتم الموافقة على طلب التدريب', 'Training request not approved');
    expect(eventEmailsTo(api, trainee.email)).toHaveLength(before);
    expect(eventEmailsTo(api, hr.email)).toHaveLength(hrBefore); // HR's own decision is not e-mailed to HR
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

describe('event e-mails disabled (the code default and the test configuration)', () => {
  it('the same workflows send no event e-mail at all', async () => {
    const api = createTestApi(); // the test configuration: EVENT_EMAILS=disabled (vitest.config.ts)
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

  it('is off unless EVENT_EMAILS is exactly enabled; production (wrangler.jsonc) enables it, tests do not', () => {
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
    expect(wranglerConfig).toMatch(/"EVENT_EMAILS":\s*"enabled"/); // production, owner decision 2026-11-11
    expect(loadSettings(env as unknown as Bindings).eventEmails).toBe(false); // the test configuration
  });
});

describe('a failed event e-mail never changes the business operation', () => {
  /** Captures sign-in codes (so trainees can sign in) and fails every other e-mail, like an SMTP outage. */
  class FailingEventSender implements EmailSender {
    readonly sent: EmailMessage[] = [];
    readonly failed: EmailMessage[] = [];
    async send(message: EmailMessage) {
      if (message.subject.startsWith(SIGN_IN_SUBJECT)) {
        this.sent.push(message);
        return;
      }
      this.failed.push(message);
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
    const applicationId = await submitApplication(trainee.client, field.id); // its e-mails (trainee, HR) fail too
    const reason = unique('Private reason');
    const response = await hr.client.post(`/api/hr/applications/${applicationId}/reject`, { reason });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ id: applicationId, status: 'Rejected', rejectionReason: reason });
    expect(failing.failed.filter((m) => m.to === trainee.email).map((m) => m.subject)).toEqual([
      'تم استلام طلب التدريب / Training application received',
      'لم يتم قبول طلب التدريب / Training application not accepted',
    ]);
    expect(failing.failed.some((m) => m.to === hr.email && m.subject === NEW_APPLICATION)).toBe(true);
    expect(loggedInfo.filter((line) => line.includes('Event e-mail sent'))).toEqual([]);

    const stored = await withDb((db) =>
      db.query<{ status: string }>('SELECT status FROM training_applications WHERE id = $1', [applicationId]),
    );
    expect(stored.rows[0]!.status).toBe('Rejected');
    const logs = logged.join('\n');
    expect(logs).toContain('"kind":"ApplicationRejected"');
    expect(logs).toContain(applicationId);
    for (const secret of [trainee.email, hr.email, reason, field.name]) expect(logs).not.toContain(secret);
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

  it('sends one separate message per recipient, never loads anything when disabled, and survives a loading error', async () => {
    const sent: EmailMessage[] = [];
    const enabled = fakeContext(sent);
    const content: EventEmailContent = {
      kind: 'MentorRequestSubmitted',
      field: 'F',
      traineeName: 'T',
      employeeName: 'E',
    };
    await sendEventEmails(enabled.c, async () => [
      { ...event(content), recipient: { type: 'Employee', id: 'h1', email: 'hr1@company.example' } },
      { ...event(content), recipient: { type: 'Employee', id: 'h2', email: 'hr2@company.example' } },
    ]);
    await enabled.done();
    expect(sent.map((m) => m.to)).toEqual(['hr1@company.example', 'hr2@company.example']);

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

describe('templates of all eight events', () => {
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
      {
        kind: 'AssignmentApproved',
        field: HOSTILE,
        startDate: '2031-02-01',
        mentorName: HOSTILE,
        mentorEmail: 'mentor@company.example',
      },
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

describe('HR recipients (NEW-24): every user whose current role is HR, at their registered address', () => {
  const api = createTestApi({}, ENABLED);

  /** The loader's recipients and the HR users, read in one snapshot (other test files change roles in parallel). */
  async function recipientsAndHr(load: (q: Pick<import('pg').Client, 'query'>) => Promise<EventEmail[]>) {
    return withDb(async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        const events = await load(db);
        const hr = await db.query<{ id: string; email: string }>(
          "SELECT id, email FROM employees WHERE role = 'HR' ORDER BY id",
        );
        return { events, hr: hr.rows };
      } finally {
        await db.query('ROLLBACK');
      }
    });
  }

  // The new-application e-mail goes to every current HR user (NEW-24). The mentor-request e-mail goes only to the
  // application's current responsible HR (AD-64): see responsible-hr.test.ts.
  it('new application: follows the current role, a former HR user is dropped, a new HR user is added; others never receive it', async () => {
    const { admin, hr, employee, field } = await cast(api);
    const hr2 = await signInStaff(api, 'HR');
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);

    await setRole(hr2.email, 'Employee'); // no longer HR
    await setRole(admin.email, 'HR'); // now HR

    for (const load of [
      (q: Parameters<typeof applicationSubmittedEmails>[0]) => applicationSubmittedEmails(q, applicationId),
    ]) {
      const { events, hr: hrUsers } = await recipientsAndHr(load);
      expect(events.map((e) => [e.recipient.id, e.recipient.email])).toEqual(hrUsers.map((u) => [u.id, u.email]));
      const to = events.map((e) => e.recipient.email);
      expect(to).toContain(hr.email);
      expect(to).toContain(admin.email);
      expect(to).not.toContain(hr2.email);
      expect(to).not.toContain(employee.email);
      expect(to).not.toContain(trainee.email);
      expect(new Set(to).size).toBe(to.length);
    }
  });

  it('logs each HR e-mail by kind and record only, never the HR addresses', async () => {
    const { hr, employee, field } = await cast(api);
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id);
    await hr.client.post(`/api/hr/applications/${applicationId}/accept`);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const requestId = (
      await body<{ id: string }>(
        await employee.client.post('/api/employee/mentor-requests', { applicationId, note: 'Request' }),
      )
    ).id;
    const lines = logged.filter((line) => line.includes('Event e-mail sent'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toEqual({
        level: 'info',
        message: 'Event e-mail sent (log line only, no delivery record)',
        kind: 'MentorRequestSubmitted',
        entityId: requestId,
      });
    }
    for (const secret of [hr.email, employee.email, trainee.email, field.name]) {
      expect(logged.join('\n')).not.toContain(secret);
    }
  });
});
