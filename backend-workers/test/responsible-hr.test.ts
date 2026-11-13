import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/config';
import { eligibleResponsibleHr } from '../src/features/training/responsibleHr';
import { body, createTestApi, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * Responsible HR (AD-64, owner 2026-11-13): the HR member who accepted an application is its responsible HR
 * (`training_applications.decided_by_id`, never changed) until an Admin appoints a replacement (insert-only
 * `responsible_hr_changes`). A mentor request is notified, in-app and by e-mail, only to the current responsible HR
 * while they hold the HR role; with none eligible, the request is kept and nobody is notified. A new application still
 * notifies every HR user.
 */
const ENABLED: Partial<Bindings> = { EVENT_EMAILS: 'enabled' };
const api = createTestApi({}, ENABLED);
const NEW_MENTOR_REQUEST = 'طلب تدريب متدرب / Request to train a trainee';
const NEW_APPLICATION = 'طلب تدريب جديد / New training application';

interface ResponsibleHr {
  acceptedBy: { id: string; fullName: string };
  current: { id: string; fullName: string; isHr: boolean };
  changes: { sequence: number; hr: { id: string; fullName: string }; changedBy: string; changedAt: string }[];
}
interface AcceptedTrainee {
  applicationId: string;
  responsibleHr: ResponsibleHr;
}

async function people() {
  const admin = await signInStaff(api, 'Admin');
  const hrA = await signInStaff(api, 'HR');
  const hrB = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const field = await newField(admin.client);
  return { admin, hrA, hrB, employee, field };
}

/** A new application accepted by `hr`. */
async function acceptedBy(hr: TestClient, fieldId: string) {
  const trainee = await signInTrainee(api);
  const applicationId = await submitApplication(trainee.client, fieldId);
  expect((await hr.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  return applicationId;
}

const requestMentoring = async (employee: TestClient, applicationId: string) => {
  const response = await employee.post('/api/employee/mentor-requests', { applicationId, note: 'I can mentor.' });
  expect(response.status).toBe(201);
  return (await body<{ id: string }>(response)).id;
};

/** Who got the in-app notification and the e-mail of one mentor request. */
async function notified(testApi: TestApi, requestId: string, sentBefore: number) {
  const inApp = await withDb((db) =>
    db.query<{ recipient_id: string }>(
      `SELECT recipient_id FROM notifications WHERE type = 'MentorRequestSubmitted' AND entity_id = $1 ORDER BY 1`,
      [requestId],
    ),
  );
  const emails = testApi.emails.sent.slice(sentBefore).filter((m) => m.subject === NEW_MENTOR_REQUEST);
  return { inApp: inApp.rows.map((r) => r.recipient_id), emails: emails.map((m) => m.to) };
}

const appoint = (admin: TestClient, applicationId: string, hrId: string) =>
  admin.put(`/api/admin/accepted-trainees/${applicationId}/responsible-hr`, { hrId });

const responsibleHr = async (admin: TestClient, applicationId: string) =>
  (await body<AcceptedTrainee[]>(await admin.get('/api/admin/accepted-trainees'))).find(
    (a) => a.applicationId === applicationId,
  )!.responsibleHr;

const changeRole = (admin: TestClient, userId: string, role: string) =>
  admin.put(`/api/admin/users/${userId}/role`, { role });

describe('mentor-request notifications go only to the current responsible HR', () => {
  it('HR A accepted: only HR A is notified (in-app and e-mail); HR B gets neither', async () => {
    const { hrA, hrB, employee, field } = await people();
    const applicationId = await acceptedBy(hrA.client, field.id);
    const before = api.emails.sent.length;
    const requestId = await requestMentoring(employee.client, applicationId);

    expect(await notified(api, requestId, before)).toEqual({ inApp: [hrA.user.id], emails: [hrA.email] });
    // HR B (still HR) sees the request in the HR list and may decide it: only the notification routing changed.
    const list = await body<{ id: string }[]>(await hrB.client.get('/api/hr/mentor-requests'));
    expect(list.map((r) => r.id)).toContain(requestId);
  });

  it('after the Admin replaces HR A with HR B, later mentor requests notify only HR B', async () => {
    const { admin, hrA, hrB, employee, field } = await people();
    const applicationId = await acceptedBy(hrA.client, field.id);
    const first = await requestMentoring(employee.client, applicationId);
    expect((await hrA.client.post(`/api/hr/mentor-requests/${first}/reject`)).status).toBe(200);

    expect((await appoint(admin.client, applicationId, hrB.user.id)).status).toBe(200);
    const before = api.emails.sent.length;
    const second = await requestMentoring(employee.client, applicationId);
    expect(await notified(api, second, before)).toEqual({ inApp: [hrB.user.id], emails: [hrB.email] });
  });

  it('HR A loses the HR role before a replacement: the request is kept, nobody is notified; then the replacement is', async () => {
    const { admin, hrA, hrB, employee, field } = await people();
    const applicationId = await acceptedBy(hrA.client, field.id);
    expect((await changeRole(admin.client, hrA.user.id, 'Employee')).status).toBe(200);

    const before = api.emails.sent.length;
    const kept = await requestMentoring(employee.client, applicationId);
    expect(await notified(api, kept, before)).toEqual({ inApp: [], emails: [] }); // not HR A, not every HR user
    const stored = await withDb((db) => db.query('SELECT status FROM mentor_requests WHERE id = $1', [kept]));
    expect(stored.rows).toEqual([{ status: 'Pending' }]);
    expect((await responsibleHr(admin.client, applicationId)).current).toEqual({
      id: hrA.user.id,
      fullName: expect.any(String),
      isHr: false,
    });

    // The former HR cannot be appointed again while not HR; an eligible HR can.
    const refused = await appoint(admin.client, applicationId, hrA.user.id);
    expect(refused.status).toBe(400);
    expect((await body(refused)).code).toBe('responsible_hr.not_hr');
    expect((await appoint(admin.client, applicationId, hrB.user.id)).status).toBe(200);

    expect((await hrB.client.post(`/api/hr/mentor-requests/${kept}/reject`)).status).toBe(200);
    const after = api.emails.sent.length;
    const next = await requestMentoring(employee.client, applicationId);
    expect(await notified(api, next, after)).toEqual({ inApp: [hrB.user.id], emails: [hrB.email] });
  });

  it('a new training application still notifies every HR user, in-app and by e-mail', async () => {
    const { admin, hrA, hrB, employee, field } = await people();
    const trainee = await signInTrainee(api);
    const before = api.emails.sent.length;
    const applicationId = await submitApplication(trainee.client, field.id);
    const inApp = await withDb((db) =>
      db.query<{ recipient_id: string }>(
        `SELECT recipient_id FROM notifications WHERE type = 'ApplicationSubmitted' AND entity_id = $1`,
        [applicationId],
      ),
    );
    const recipients = inApp.rows.map((r) => r.recipient_id);
    const emails = api.emails.sent
      .slice(before)
      .filter((m) => m.subject === NEW_APPLICATION)
      .map((m) => m.to);
    for (const hr of [hrA, hrB]) {
      expect(recipients).toContain(hr.user.id);
      expect(emails).toContain(hr.email);
    }
    // Not the Admin or the Employee, and one copy each. (Other test files add and change HR users concurrently, so the
    // exact number of HR users is not fixed here; event-emails.test.ts checks the full HR set.)
    for (const other of [admin, employee]) {
      expect(recipients).not.toContain(other.user.id);
      expect(emails).not.toContain(other.email);
    }
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(new Set(emails).size).toBe(emails.length);
  });
});

describe('the Admin appoints the responsible HR', () => {
  it('an existing accepted application resolves to the HR who accepted it, with no changes recorded', async () => {
    const { admin, hrA, field } = await people();
    const applicationId = await acceptedBy(hrA.client, field.id);
    expect(await responsibleHr(admin.client, applicationId)).toEqual({
      acceptedBy: { id: hrA.user.id, fullName: expect.any(String) },
      current: { id: hrA.user.id, fullName: expect.any(String), isHr: true },
      changes: [],
    });
    expect(await withDb((db) => eligibleResponsibleHr(db, applicationId))).toEqual({
      id: hrA.user.id,
      email: hrA.email,
    });
  });

  it('keeps the accepting HR and every replacement, in order, audited with the Admin as the actor', async () => {
    const { admin, hrA, hrB, field } = await people();
    const hrC = await signInStaff(api, 'HR');
    const applicationId = await acceptedBy(hrA.client, field.id);
    expect((await appoint(admin.client, applicationId, hrB.user.id)).status).toBe(200);
    const response = await appoint(admin.client, applicationId, hrC.user.id);
    expect(response.status).toBe(200);
    const result = (await body<AcceptedTrainee>(response)).responsibleHr;
    expect(result.acceptedBy.id).toBe(hrA.user.id);
    expect(result.current).toMatchObject({ id: hrC.user.id, isHr: true });
    expect(result.changes.map((c) => [c.sequence, c.hr.id])).toEqual([
      [1, hrB.user.id],
      [2, hrC.user.id],
    ]);
    expect(result.changes.every((c) => typeof c.changedBy === 'string' && c.changedAt)).toBe(true);

    // Appointing the current responsible HR again records nothing.
    expect((await appoint(admin.client, applicationId, hrC.user.id)).status).toBe(200);
    const rows = await withDb((db) =>
      db.query<{ id: string; sequence: number; changed_by_id: string }>(
        'SELECT id, sequence, changed_by_id FROM responsible_hr_changes WHERE application_id = $1 ORDER BY sequence',
        [applicationId],
      ),
    );
    expect(rows.rows.map((r) => [r.sequence, r.changed_by_id])).toEqual([
      [1, admin.user.id],
      [2, admin.user.id],
    ]);
    const original = await withDb((db) =>
      db.query('SELECT decided_by_id FROM training_applications WHERE id = $1', [applicationId]),
    );
    expect(original.rows).toEqual([{ decided_by_id: hrA.user.id }]);
    const audit = await withDb((db) =>
      db.query<{ entity_id: string; operation: string; actor_type: string; actor_id: string }>(
        `SELECT entity_id, operation, actor_type, actor_id FROM audit_logs
          WHERE table_name = 'responsible_hr_changes' AND entity_id = ANY($1::text[]) ORDER BY id`,
        [rows.rows.map((r) => r.id)],
      ),
    );
    expect(audit.rows).toEqual(
      rows.rows.map((r) => ({ entity_id: r.id, operation: 'INSERT', actor_type: 'Staff', actor_id: admin.user.id })),
    );
  });

  it('only the Admin may appoint; HR, Employee and Trainee are refused, signed-out callers too', async () => {
    const { hrA, hrB, employee, field } = await people();
    const applicationId = await acceptedBy(hrA.client, field.id);
    const trainee = await signInTrainee(api);
    for (const [name, client] of [
      ['HR', hrA.client],
      ['Employee', employee.client],
      ['Trainee', trainee.client],
    ] as const) {
      expect((await appoint(client, applicationId, hrB.user.id)).status, name).toBe(403);
    }
    expect((await appoint(api.client(), applicationId, hrB.user.id)).status).toBe(401);
    const rows = await withDb((db) =>
      db.query('SELECT 1 FROM responsible_hr_changes WHERE application_id = $1', [applicationId]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('refuses a user who is not HR now, a bad id, an application that is not accepted, and an unknown one', async () => {
    const { admin, hrA, hrB, employee, field } = await people();
    const applicationId = await acceptedBy(hrA.client, field.id);
    for (const [hrId, code] of [
      [employee.user.id, 'responsible_hr.not_hr'],
      [admin.user.id, 'responsible_hr.not_hr'],
      [crypto.randomUUID(), 'responsible_hr.not_hr'],
      ['not-a-guid', 'validation.required'],
    ] as const) {
      const refused = await appoint(admin.client, applicationId, hrId);
      expect(refused.status, hrId).toBe(400);
      expect((await body(refused)).code, hrId).toBe(code);
    }
    const trainee = await signInTrainee(api);
    const submitted = await submitApplication(trainee.client, field.id);
    const notAccepted = await appoint(admin.client, submitted, hrB.user.id);
    expect(notAccepted.status).toBe(400);
    expect((await body(notAccepted)).code).toBe('application.invalid_status');
    expect((await appoint(admin.client, crypto.randomUUID(), hrB.user.id)).status).toBe(404);
    const rows = await withDb((db) =>
      db.query('SELECT 1 FROM responsible_hr_changes WHERE application_id = $1', [applicationId]),
    );
    expect(rows.rows).toEqual([]);
  });

  it('concurrent appointments are recorded one after the other; the last one is current', async () => {
    const { admin, hrA, hrB, field } = await people();
    const hrC = await signInStaff(api, 'HR');
    const admin2 = await signInStaff(api, 'Admin');
    const applicationId = await acceptedBy(hrA.client, field.id);
    const results = await Promise.all([
      appoint(admin.client, applicationId, hrB.user.id),
      appoint(admin2.client, applicationId, hrC.user.id),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await withDb((db) =>
      db.query<{ sequence: number; hr_id: string }>(
        'SELECT sequence, hr_id FROM responsible_hr_changes WHERE application_id = $1 ORDER BY sequence',
        [applicationId],
      ),
    );
    expect(rows.rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect((await responsibleHr(admin.client, applicationId)).current.id).toBe(rows.rows[1]!.hr_id);
  });
});
