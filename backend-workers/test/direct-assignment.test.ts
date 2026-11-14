import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/config';
import type { EmailMessage } from '../src/email';
import { calendarDate } from '../src/domain/training';
import { DIRECT_ASSIGNMENT_REJECTION_REASON } from '../src/features/training/hrRoutes';
import { body, createTestApi, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * HR direct assignment (AD-67, owner decisions 2026-11-14; PDF §4 HR): only the application's current responsible HR
 * (AD-64) assigns an Accepted trainee that has never had an assignment directly to a user who holds the Employee role,
 * with the start and planned end dates, without a request; in the same transaction every pending mentor request for the
 * trainee is rejected with the reason and the mentor gets an in-app notification; after the commit the mentor and the
 * trainee get one e-mail each.
 */
const ENABLED: Partial<Bindings> = { EVENT_EMAILS: 'enabled' };
const api = createTestApi({}, ENABLED);
const MENTOR_SUBJECT = 'أسندت إليك الموارد البشرية متدربًا / HR has assigned a trainee to you';
const TRAINEE_SUBJECT = 'تم تحديد مدرّبك / Your mentor has been assigned';
/** The ordinary rejection e-mail of a mentor request (the same as when HR rejects a request). */
const REJECTED_SUBJECT = 'لم تتم الموافقة على طلب التدريب / Training request not approved';
const today = () => calendarDate(new Date());

/** An application accepted by HR A (its responsible HR), with three employees and two other HR users around. */
async function accepted(testApi: TestApi = api) {
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
  return { admin, hrA, hrB, mentorA, mentorB, mentorC, trainee, field, applicationId };
}

const assign = (client: TestClient, applicationId: string, payload: object) =>
  client.post(`/api/hr/applications/${applicationId}/direct-assignment`, payload);
const request = async (client: TestClient, applicationId: string) => {
  const response = await client.post('/api/employee/mentor-requests', { applicationId, note: 'I can train them' });
  expect(response.status).toBe(201);
  return (await body<{ id: string }>(response)).id;
};
const period = { startDate: '2027-01-10', endDate: '2027-04-30' };

const assignments = (applicationId: string) =>
  withDb((db) =>
    db.query<{
      id: string;
      employee_id: string;
      mentor_request_id: string | null;
      status: string;
      start: string;
      end: string;
    }>(
      `SELECT id, employee_id, mentor_request_id, status, start_date::text AS start, end_date::text AS end
         FROM assignments WHERE application_id = $1 ORDER BY created_at`,
      [applicationId],
    ),
  ).then((r) => r.rows);
const requests = (applicationId: string) =>
  withDb((db) =>
    db.query<{ id: string; status: string; decided_by_id: string | null; rejection_reason: string | null }>(
      `SELECT id, status, decided_by_id, rejection_reason FROM mentor_requests WHERE application_id = $1 ORDER BY requested_at`,
      [applicationId],
    ),
  ).then((r) => r.rows);
const notificationsOf = (recipientId: string) =>
  withDb((db) =>
    db.query<{ type: string; entity_id: string }>(
      // The types an assignment decision can write (setup creates others: new application, new mentor request).
      "SELECT type, entity_id FROM notifications WHERE recipient_id = $1 AND type IN ('TraineeDirectlyAssigned', 'MentorRequestApproved', 'MentorRequestRejected')",
      [recipientId],
    ),
  ).then((r) => r.rows);

describe('HR direct assignment (AD-67)', () => {
  it('the responsible HR assigns directly: one Active assignment, no request, every pending request rejected, audited', async () => {
    const t = await accepted();
    const requestA = await request(t.mentorA.client, t.applicationId);
    const requestB = await request(t.mentorB.client, t.applicationId); // the chosen mentor's own request
    const requestC = await request(t.mentorC.client, t.applicationId);
    const other = await accepted(); // another trainee's pending request stays untouched
    const otherRequest = await request(t.mentorA.client, other.applicationId);
    const detail = await body<{ canDirectAssign: boolean }>(
      await t.hrA.client.get(`/api/hr/applications/${t.applicationId}`),
    );
    expect(detail.canDirectAssign).toBe(true);
    expect(
      (await body<{ canDirectAssign: boolean }>(await t.hrB.client.get(`/api/hr/applications/${t.applicationId}`)))
        .canDirectAssign,
    ).toBe(false);
    const sentBefore = api.emails.sent.length;

    const response = await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id, ...period });
    expect(response.status).toBe(201);
    const result = await body<{
      assignment: { id: string; status: string; employee: { id: string } };
      rejectedMentorRequests: number;
    }>(response);
    expect(result.rejectedMentorRequests).toBe(3);
    expect(result.assignment).toMatchObject({ status: 'Active', employee: { id: t.mentorB.user.id } });

    expect(await assignments(t.applicationId)).toEqual([
      {
        id: result.assignment.id,
        employee_id: t.mentorB.user.id,
        mentor_request_id: null,
        status: 'Active',
        start: period.startDate,
        end: period.endDate,
      },
    ]);
    expect(await requests(t.applicationId)).toEqual(
      [requestA, requestB, requestC].map((id) => ({
        id,
        status: 'Rejected',
        decided_by_id: t.hrA.user.id,
        rejection_reason: DIRECT_ASSIGNMENT_REJECTION_REASON,
      })),
    );
    expect(await requests(other.applicationId)).toEqual([
      { id: otherRequest, status: 'Pending', decided_by_id: null, rejection_reason: null },
    ]);

    // One transaction, audited with HR A as the actor: the assignment, the three rejections, the mentor's notification.
    const audit = await withDb((db) =>
      db.query<{ table_name: string; operation: string; actor_type: string; actor_id: string }>(
        `SELECT table_name, operation, actor_type, actor_id FROM audit_logs
          WHERE transaction_id = (SELECT transaction_id FROM audit_logs WHERE table_name = 'assignments' AND entity_id = $1)
          ORDER BY id`,
        [result.assignment.id],
      ),
    );
    const actor = { actor_type: 'Staff', actor_id: t.hrA.user.id };
    expect(audit.rows).toEqual([
      { table_name: 'assignments', operation: 'INSERT', ...actor },
      { table_name: 'mentor_requests', operation: 'UPDATE', ...actor },
      { table_name: 'mentor_requests', operation: 'UPDATE', ...actor },
      { table_name: 'mentor_requests', operation: 'UPDATE', ...actor },
      // The chosen mentor's direct-assignment notice, then the ordinary rejection notice of the two other requesters.
      { table_name: 'notifications', operation: 'INSERT', ...actor },
      { table_name: 'notifications', operation: 'INSERT', ...actor },
      { table_name: 'notifications', operation: 'INSERT', ...actor },
    ]);

    // AD-64: the responsible HR is still HR A.
    const responsibility = await withDb((db) =>
      db.query(
        `SELECT a.decided_by_id, (SELECT count(*)::int FROM responsible_hr_changes r WHERE r.application_id = a.id) AS changes
           FROM training_applications a WHERE a.id = $1`,
        [t.applicationId],
      ),
    );
    expect(responsibility.rows).toEqual([{ decided_by_id: t.hrA.user.id, changes: 0 }]);

    // Notifications: the chosen mentor gets only the direct-assignment notices (e-mail + in-app), never a rejection
    // notice although their own request was rejected; the trainee the direct-assignment e-mail; every other requester the
    // ordinary rejection notices (e-mail + in-app); nobody else.
    const sent = api.emails.sent.slice(sentBefore);
    expect(sent.slice(0, 2).map((m) => [m.to, m.subject])).toEqual([
      [t.mentorB.email, MENTOR_SUBJECT],
      [t.trainee.email, TRAINEE_SUBJECT],
    ]);
    expect(
      sent
        .slice(2)
        .map((m) => [m.to, m.subject])
        .sort(),
    ).toEqual(
      [
        [t.mentorA.email, REJECTED_SUBJECT],
        [t.mentorC.email, REJECTED_SUBJECT],
      ].sort(),
    );
    expect(sent.filter((m) => m.to === t.mentorB.email).map((m) => m.subject)).toEqual([MENTOR_SUBJECT]);
    const traineeMail = sent[1]!.textBody;
    for (const value of [t.mentorB.email, period.startDate, period.endDate, 'Planned end date:']) {
      expect(traineeMail).toContain(value);
    }
    expect(sent[0]!.textBody).toContain(period.endDate);
    expect(sent[0]!.textBody.indexOf('أسندت إليك')).toBe(0); // Arabic first
    expect(await notificationsOf(t.mentorB.user.id)).toEqual([
      { type: 'TraineeDirectlyAssigned', entity_id: t.applicationId },
    ]);
    expect(await notificationsOf(t.mentorA.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: requestA }]);
    expect(await notificationsOf(t.mentorC.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: requestC }]);
    for (const user of [t.hrA, t.hrB, t.admin]) {
      expect(await notificationsOf(user.user.id), user.email).toEqual([]);
    }
    const inbox = await body<{ notifications: { type: string; traineeName: string | null; applicationId: string }[] }>(
      await t.mentorB.client.get('/api/notifications'),
    );
    expect(inbox.notifications[0]).toMatchObject({ type: 'TraineeDirectlyAssigned', applicationId: t.applicationId });

    // Views: HR trainings, the mentor's My trainees, the Admin's accepted trainees; no longer available to request.
    const hrList = await body<{ id: string }[]>(await t.hrB.client.get('/api/hr/assignments'));
    expect(hrList.some((a) => a.id === result.assignment.id)).toBe(true);
    const mine = await body<{ id: string; status: string }[]>(await t.mentorB.client.get('/api/employee/trainees'));
    expect(mine.find((a) => a.id === result.assignment.id)?.status).toBe('Active');
    const available = await body<{ id: string }[]>(await t.mentorC.client.get('/api/employee/available-trainees'));
    expect(available.some((a) => a.id === t.applicationId)).toBe(false);
    const adminView = await body<{ applicationId: string; assignments: { status: string }[] }[]>(
      await t.admin.client.get('/api/admin/accepted-trainees'),
    );
    expect(adminView.find((a) => a.applicationId === t.applicationId)?.assignments.map((s) => s.status)).toEqual([
      'Active',
    ]);
    const myRequests = await body<{ id: string; status: string; rejectionReason: string | null }[]>(
      await t.mentorA.client.get('/api/employee/mentor-requests'),
    );
    expect(myRequests.find((r) => r.id === requestA)).toMatchObject({
      status: 'Rejected',
      rejectionReason: DIRECT_ASSIGNMENT_REJECTION_REASON,
    });

    // A rejected request can no longer be approved; the trainee cannot be assigned again.
    const approve = await t.hrA.client.post(`/api/hr/mentor-requests/${requestA}/approve`, period);
    expect((await body(approve)).code).toBe('mentor_request.invalid_status');
    const again = await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorC.user.id, ...period });
    expect(again.status).toBe(409);
    expect((await body(again)).code).toBe('direct_assignment.already_assigned');
    expect(
      (await body<{ canDirectAssign: boolean }>(await t.hrA.client.get(`/api/hr/applications/${t.applicationId}`)))
        .canDirectAssign,
    ).toBe(false);
  });

  it('only the current responsible HR: other HR 403; Admin, Employee, Trainee refused; signed out 401; replacement moves it', async () => {
    const t = await accepted();
    const payload = { employeeId: t.mentorB.user.id, ...period };
    const otherHr = await assign(t.hrB.client, t.applicationId, payload);
    expect(otherHr.status).toBe(403);
    expect((await body(otherHr)).code).toBe('direct_assignment.not_responsible');
    for (const client of [t.admin.client, t.mentorA.client, t.trainee.client]) {
      expect((await assign(client, t.applicationId, payload)).status).toBe(403);
    }
    expect((await assign(api.client(), t.applicationId, payload)).status).toBe(401);
    expect((await assign(t.hrA.client, crypto.randomUUID(), payload)).status).toBe(404);

    // AD-64: after an Admin's replacement, the new responsible HR may, the former may not.
    expect(
      (
        await t.admin.client.put(`/api/admin/accepted-trainees/${t.applicationId}/responsible-hr`, {
          hrId: t.hrB.user.id,
        })
      ).status,
    ).toBe(200);
    expect((await assign(t.hrA.client, t.applicationId, payload)).status).toBe(403);
    expect(await assignments(t.applicationId)).toEqual([]);
    expect((await assign(t.hrB.client, t.applicationId, payload)).status).toBe(201);
  });

  it('refuses a non-accepted application, any earlier assignment, a mentor who is not an Employee and invalid dates; nothing written', async () => {
    const t = await accepted();
    const pending = await request(t.mentorA.client, t.applicationId);
    const ok = { employeeId: t.mentorB.user.id, ...period };
    for (const [payload, code] of [
      [{ ...ok, employeeId: t.hrB.user.id }, 'direct_assignment.mentor_not_employee'],
      [{ ...ok, employeeId: t.admin.user.id }, 'direct_assignment.mentor_not_employee'],
      [{ ...ok, employeeId: crypto.randomUUID() }, 'direct_assignment.mentor_not_employee'],
      [{ ...ok, employeeId: 'not-a-guid' }, 'validation.required'],
      [{ ...ok, startDate: '2027-05-01', endDate: '2027-04-30' }, 'assignment.invalid_period'],
      [{ ...ok, startDate: 'soon' }, 'validation.required'],
    ] as const) {
      const refused = await assign(t.hrA.client, t.applicationId, payload);
      expect(refused.status, JSON.stringify(payload)).toBe(400);
      expect((await body(refused)).code, JSON.stringify(payload)).toBe(code);
    }
    const missing = await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id });
    expect(Object.keys((await body<{ errors: Record<string, string[]> }>(missing)).errors).sort()).toEqual([
      'EndDate',
      'StartDate',
    ]);
    expect(await assignments(t.applicationId)).toEqual([]);
    expect((await requests(t.applicationId)).map((r) => [r.id, r.status])).toEqual([[pending, 'Pending']]);
    // The same start and end date is a valid period.
    expect(
      (await assign(t.hrA.client, t.applicationId, { ...ok, startDate: '2027-02-01', endDate: '2027-02-01' })).status,
    ).toBe(201);

    // A rejected application (its deciding HR resolves as responsible): not Accepted.
    const trainee = await signInTrainee(api);
    const rejectedId = await submitApplication(trainee.client, t.field.id);
    expect((await t.hrA.client.post(`/api/hr/applications/${rejectedId}/reject`, { reason: 'No' })).status).toBe(200);
    const notAccepted = await assign(t.hrA.client, rejectedId, ok);
    expect((await body(notAccepted)).code).toBe('direct_assignment.not_accepted');
    // A submitted application has no responsible HR yet.
    const submittedId = await submitApplication((await signInTrainee(api)).client, t.field.id);
    expect((await assign(t.hrA.client, submittedId, ok)).status).toBe(403);

    // Any earlier assignment, even one that has ended, blocks a direct assignment.
    for (const status of ['Completed', 'Withdrawn', 'Active']) {
      const u = await accepted();
      await seedAssignment(u.applicationId, u.mentorA.user.id, '2026-01-01', '2026-03-01', status);
      const refused = await assign(u.hrA.client, u.applicationId, { employeeId: u.mentorB.user.id, ...period });
      expect(refused.status, status).toBe(409);
      expect((await body(refused)).code).toBe('direct_assignment.already_assigned');
      expect((await assignments(u.applicationId)).length).toBe(1);
    }
  });

  it('concurrency: with a racing request approval or direct assignments, exactly one assignment; a loser writes nothing', async () => {
    const t = await accepted();
    const requestA = await request(t.mentorA.client, t.applicationId);
    const requestC = await request(t.mentorC.client, t.applicationId);
    const before = api.emails.sent.length;
    const [direct, approval] = await Promise.all([
      assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id, ...period }),
      t.hrB.client.post(`/api/hr/mentor-requests/${requestA}/approve`, period),
    ]);
    const rows = await assignments(t.applicationId);
    expect(rows.filter((a) => a.status === 'Active')).toHaveLength(1);
    const reqs = await requests(t.applicationId);
    if (direct.status === 201) {
      expect(approval.status).not.toBe(200);
      expect(rows[0]).toMatchObject({ employee_id: t.mentorB.user.id, mentor_request_id: null });
      expect(reqs.map((r) => r.status)).toEqual(['Rejected', 'Rejected']);
    } else {
      // The approval won: the direct assignment rolled back entirely (the other request is still Pending, no mentor mail).
      expect(approval.status).toBe(200);
      expect(direct.status).toBe(409);
      expect(reqs.find((r) => r.id === requestA)?.status).toBe('Approved');
      expect(reqs.find((r) => r.id === requestC)).toMatchObject({ status: 'Pending', rejection_reason: null });
      expect(api.emails.sent.slice(before).filter((m) => m.subject === MENTOR_SUBJECT)).toEqual([]);
      // The failed direct assignment notified nobody: no rejection notice for the request that stayed Pending.
      expect(await notificationsOf(t.mentorC.user.id)).toEqual([]);
      expect(api.emails.sent.slice(before).filter((m) => m.to === t.mentorC.email)).toEqual([]);
    }

    // A double-clicked or repeated submission: one assignment, and each notice once (also the other requester's).
    const u = await accepted();
    const otherRequest = await request(u.mentorA.client, u.applicationId);
    const sent = api.emails.sent.length;
    const results = await Promise.all(
      [1, 2, 3].map(() => assign(u.hrA.client, u.applicationId, { employeeId: u.mentorB.user.id, ...period })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((r) => r.status !== 201)) expect(r.status).toBe(409);
    expect(await assignments(u.applicationId)).toHaveLength(1);
    expect(await notificationsOf(u.mentorB.user.id)).toHaveLength(1);
    expect(await notificationsOf(u.mentorA.user.id)).toEqual([
      { type: 'MentorRequestRejected', entity_id: otherRequest },
    ]);
    expect(
      api.emails.sent
        .slice(sent)
        .map((m) => m.subject)
        .sort(),
    ).toEqual([MENTOR_SUBJECT, TRAINEE_SUBJECT, REJECTED_SUBJECT].sort());
  });

  it('the chosen mentor: with no pending request, or as the only requester, gets only the direct-assignment notices', async () => {
    // Without a pending request of their own (another employee's request is rejected and notified as usual).
    const t = await accepted();
    const requestA = await request(t.mentorA.client, t.applicationId);
    const before = api.emails.sent.length;
    expect((await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id, ...period })).status).toBe(
      201,
    );
    const sent = api.emails.sent.slice(before);
    expect(sent.filter((m) => m.to === t.mentorB.email).map((m) => m.subject)).toEqual([MENTOR_SUBJECT]);
    expect(sent.filter((m) => m.to === t.mentorA.email).map((m) => m.subject)).toEqual([REJECTED_SUBJECT]);
    expect(await notificationsOf(t.mentorB.user.id)).toEqual([
      { type: 'TraineeDirectlyAssigned', entity_id: t.applicationId },
    ]);
    expect(await notificationsOf(t.mentorA.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: requestA }]);

    // As the only requester: their request is rejected (with the reason), and no rejection notice goes to anyone.
    const u = await accepted();
    const own = await request(u.mentorB.client, u.applicationId);
    const sentBefore = api.emails.sent.length;
    expect((await assign(u.hrA.client, u.applicationId, { employeeId: u.mentorB.user.id, ...period })).status).toBe(
      201,
    );
    expect(await requests(u.applicationId)).toEqual([
      {
        id: own,
        status: 'Rejected',
        decided_by_id: u.hrA.user.id,
        rejection_reason: DIRECT_ASSIGNMENT_REJECTION_REASON,
      },
    ]);
    expect(
      api.emails.sent
        .slice(sentBefore)
        .map((m) => [m.to, m.subject])
        .sort(),
    ).toEqual(
      [
        [u.mentorB.email, MENTOR_SUBJECT],
        [u.trainee.email, TRAINEE_SUBJECT],
      ].sort(),
    );
    expect(await notificationsOf(u.mentorB.user.id)).toEqual([
      { type: 'TraineeDirectlyAssigned', entity_id: u.applicationId },
    ]);

    // HR's ordinary rejection of a request still notifies its employee (unchanged).
    const v = await accepted();
    const plain = await request(v.mentorA.client, v.applicationId);
    expect((await v.hrB.client.post(`/api/hr/mentor-requests/${plain}/reject`)).status).toBe(200);
    expect(await notificationsOf(v.mentorA.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: plain }]);
  });

  it('a requester who is now an Admin: their request is rejected and audited, but they get no rejection notice', async () => {
    const t = await accepted();
    const formerEmployee = await request(t.mentorA.client, t.applicationId);
    // After requesting, mentor A becomes an Admin (AD-56: an Admin changes another user's role).
    expect((await t.admin.client.put(`/api/admin/users/${t.mentorA.user.id}/role`, { role: 'Admin' })).status).toBe(
      200,
    );
    const before = api.emails.sent.length;

    const response = await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id, ...period });
    expect(response.status).toBe(201);
    expect(await requests(t.applicationId)).toEqual([
      {
        id: formerEmployee,
        status: 'Rejected',
        decided_by_id: t.hrA.user.id,
        rejection_reason: DIRECT_ASSIGNMENT_REJECTION_REASON,
      },
    ]);
    const audit = await withDb((db) =>
      db.query<{ actor_type: string; actor_id: string }>(
        "SELECT actor_type, actor_id FROM audit_logs WHERE table_name = 'mentor_requests' AND entity_id = $1 AND operation = 'UPDATE'",
        [formerEmployee],
      ),
    );
    expect(audit.rows).toEqual([{ actor_type: 'Staff', actor_id: t.hrA.user.id }]);
    expect(await notificationsOf(t.mentorA.user.id)).toEqual([]);
    const sent = api.emails.sent.slice(before);
    expect(sent.filter((m) => m.to === t.mentorA.email)).toEqual([]);
    expect(sent.map((m) => [m.to, m.subject]).sort()).toEqual(
      [
        [t.mentorB.email, MENTOR_SUBJECT],
        [t.trainee.email, TRAINEE_SUBJECT],
      ].sort(),
    );
  });

  it('mixed requests: all rejected; the chosen mentor and the Admin get no rejection notice, the others the usual ones', async () => {
    const t = await accepted();
    const extra = await signInStaff(api, 'Employee');
    const chosenOwn = await request(t.mentorB.client, t.applicationId);
    const nowAdmin = await request(t.mentorA.client, t.applicationId);
    const plainC = await request(t.mentorC.client, t.applicationId);
    const plainD = await request(extra.client, t.applicationId);
    expect((await t.admin.client.put(`/api/admin/users/${t.mentorA.user.id}/role`, { role: 'Admin' })).status).toBe(
      200,
    );
    const before = api.emails.sent.length;

    const result = await body<{ rejectedMentorRequests: number }>(
      await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id, ...period }),
    );
    expect(result.rejectedMentorRequests).toBe(4);
    expect((await requests(t.applicationId)).map((r) => [r.id, r.status, r.rejection_reason])).toEqual(
      [chosenOwn, nowAdmin, plainC, plainD].map((id) => [id, 'Rejected', DIRECT_ASSIGNMENT_REJECTION_REASON]),
    );
    const sent = api.emails.sent.slice(before);
    const to = (email: string) => sent.filter((m) => m.to === email).map((m) => m.subject);
    expect(to(t.mentorB.email)).toEqual([MENTOR_SUBJECT]);
    expect(to(t.mentorA.email)).toEqual([]);
    expect(to(t.mentorC.email)).toEqual([REJECTED_SUBJECT]);
    expect(to(extra.email)).toEqual([REJECTED_SUBJECT]);
    expect(to(t.trainee.email)).toEqual([TRAINEE_SUBJECT]);
    expect(sent).toHaveLength(4);
    expect(await notificationsOf(t.mentorB.user.id)).toEqual([
      { type: 'TraineeDirectlyAssigned', entity_id: t.applicationId },
    ]);
    expect(await notificationsOf(t.mentorA.user.id)).toEqual([]);
    expect(await notificationsOf(t.mentorC.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: plainC }]);
    expect(await notificationsOf(extra.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: plainD }]);

    // HR's ordinary rejection of a request is unchanged by this (it is not part of the AD-67 exception).
    const v = await accepted();
    const plain = await request(v.mentorA.client, v.applicationId);
    expect((await v.hrB.client.post(`/api/hr/mentor-requests/${plain}/reject`)).status).toBe(200);
    expect(await notificationsOf(v.mentorA.user.id)).toEqual([{ type: 'MentorRequestRejected', entity_id: plain }]);
  });

  it('a failed e-mail never undoes the assignment; with e-mails off nothing is sent but the in-app notice stays', async () => {
    const failing: TestApi = createTestApi(
      {
        emailSender: () => ({
          send: (m: EmailMessage) =>
            m.subject === MENTOR_SUBJECT || m.subject === TRAINEE_SUBJECT
              ? Promise.reject(new Error('smtp down'))
              : failing.emails.send(m),
        }),
      },
      ENABLED,
    );
    const t = await accepted(failing);
    const response = await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorB.user.id, ...period });
    expect(response.status).toBe(201);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Active']);

    const off = createTestApi(); // EVENT_EMAILS disabled (the test configuration)
    const u = await accepted(off);
    const sent = off.emails.sent.length;
    expect((await assign(u.hrA.client, u.applicationId, { employeeId: u.mentorB.user.id, ...period })).status).toBe(
      201,
    );
    expect(off.emails.sent.slice(sent)).toEqual([]);
    expect(await notificationsOf(u.mentorB.user.id)).toEqual([
      { type: 'TraineeDirectlyAssigned', entity_id: u.applicationId },
    ]);
  });

  it('the directly assigned training follows the usual lifecycle: transfer (AD-65), extend and complete (AD-63)', async () => {
    const t = await accepted();
    const start = calendarDate(new Date(Date.now() - 20 * 86_400_000));
    const end = calendarDate(new Date(Date.now() + 30 * 86_400_000));
    const created = await body<{ assignment: { id: string } }>(
      await assign(t.hrA.client, t.applicationId, { employeeId: t.mentorA.user.id, startDate: start, endDate: end }),
    );
    // AD-65: only the responsible HR transfers, today.
    const moved = await t.hrA.client.post(`/api/hr/assignments/${created.assignment.id}/transfer`, {
      employeeId: t.mentorB.user.id,
      transferDate: today(),
      reason: 'Team change',
    });
    expect(moved.status).toBe(200);
    const incoming = await body<{ id: string }>(moved);
    expect(
      (
        await t.hrB.client.post(`/api/hr/assignments/${incoming.id}/extend`, {
          endDate: calendarDate(new Date(Date.now() + 40 * 86_400_000)),
          reason: 'More',
        })
      ).status,
    ).toBe(200);
    const done = await t.hrB.client.post(`/api/hr/assignments/${incoming.id}/complete`, {
      endDate: today(),
      reason: 'Early',
    });
    expect(done.status).toBe(200);
    expect((await assignments(t.applicationId)).map((a) => a.status)).toEqual(['Transferred', 'EndedEarly']);
  });
});
