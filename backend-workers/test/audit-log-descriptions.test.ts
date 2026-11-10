import { describe, expect, it } from 'vitest';
import arMessages from '../../frontend/public/i18n/ar.json?raw';
import enMessages from '../../frontend/public/i18n/en.json?raw';
import {
  AUDIT_EVENT_PARAMS,
  AUDIT_EVENTS,
  AUDIT_FACTS_SQL,
  AUDITED_TABLES,
  describeAudit,
  type AuditDescription,
} from '../src/features/admin/auditDescriptions';
import {
  body,
  COMPANY_DOMAIN,
  createTestApi,
  signInStaff,
  signInTrainee,
  type TestClient,
  uniqueEmail,
  withDb,
} from './helpers';
import { newField, submitApplication } from './seed';

/**
 * Descriptions of audit log entries (owner requirements ADL-01 to ADL-06): an event code for every entry, old or new,
 * derived when the log is read from allowlisted facts of the stored values; specific when the record shows what
 * happened, a truthful general sentence otherwise; never a stored name, note, reason, file name, hash or id.
 */
const api = createTestApi();

interface Entry {
  id: string;
  actorType: string;
  description: AuditDescription;
}

/** What the API says about audit entry `id` (read through the viewer, as the Admin). */
async function describedAs(admin: TestClient, id: string): Promise<Entry> {
  const response = await admin.get(`/api/admin/audit-logs?before=${BigInt(id) + 1n}`);
  expect(response.status).toBe(200);
  const entry = (await body<{ entries: Entry[] }>(response)).entries[0]!;
  expect(entry.id).toBe(id);
  return entry;
}

/** The ids of the audit entries matching `where` (as the database owner), oldest first. */
const auditIds = (where: string, params: unknown[]) =>
  withDb((db) =>
    db.query<{ id: string }>(`SELECT id::text AS id FROM audit_logs a WHERE ${where} ORDER BY a.id`, params),
  ).then((r) => r.rows.map((row) => row.id));

/** The events of the entries matching `where`, oldest first. */
async function events(admin: TestClient, where: string, params: unknown[]) {
  const ids = await auditIds(where, params);
  expect(ids.length).toBeGreaterThan(0);
  return Promise.all(ids.map(async (id) => (await describedAs(admin, id)).description));
}
const ofRecord = (admin: TestClient, table: string, entityId: string) =>
  events(admin, 'table_name = $1 AND entity_id = $2', [table, entityId]);

/** The facts SQL applied to a synthetic row: nothing is written, any shape can be tried. */
async function factsOf(table: string, operation: string, oldValues: unknown, newValues: unknown) {
  const { rows } = await withDb((db) =>
    db.query<{ facts: unknown }>(
      `SELECT ${AUDIT_FACTS_SQL} AS facts
         FROM (VALUES ($1::text, $2::text, $3::jsonb, $4::jsonb)) AS a(table_name, operation, old_values, new_values)`,
      [table, operation, oldValues === undefined ? null : JSON.stringify(oldValues), JSON.stringify(newValues)],
    ),
  );
  return rows[0]!.facts;
}
const describedFrom = async (table: string, operation: string, oldValues: unknown, newValues: unknown) =>
  describeAudit(table, operation, await factsOf(table, operation, oldValues, newValues));

describe('audit descriptions: every real writer, read back through the viewer', () => {
  it('applications, files, HR decisions, contact log, mentor requests, assignment, notes and notifications', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const employee = await signInStaff(api, 'Employee');

    // Fields: added active, deactivated, then renamed and activated.
    const field = await newField(admin.client);
    expect(await ofRecord(admin.client, 'fields', field.id)).toEqual([{ event: 'field.createdActive' }]);
    await admin.client.put(`/api/admin/fields/${field.id}`, { name: field.name, description: null, isActive: false });
    await admin.client.put(`/api/admin/fields/${field.id}`, {
      name: `${field.name} 2`,
      description: null,
      isActive: true,
    });
    expect((await ofRecord(admin.client, 'fields', field.id)).map((d) => d.event)).toEqual([
      'field.createdActive',
      'field.deactivated',
      'field.updatedActivated',
    ]);

    // A trainee signs in (code requested and used, account, session) and applies.
    const trainee = await signInTrainee(api);
    expect(await ofRecord(admin.client, 'trainees', trainee.user.id)).toEqual([{ event: 'trainees.created' }]);
    expect(
      await events(admin.client, "table_name = 'trainee_sign_in_codes' AND new_values ->> 'email' = $1", [
        trainee.email,
      ]),
    ).toEqual([{ event: 'trainee_sign_in_codes.created' }]);
    expect(
      await events(admin.client, "table_name = 'trainee_sign_in_codes' AND operation = 'UPDATE' AND actor_id = $1", [
        trainee.user.id,
      ]),
    ).toEqual([{ event: 'signInCode.used' }]);
    expect(
      await events(admin.client, "table_name = 'user_sessions' AND new_values ->> 'trainee_id' = $1", [
        trainee.user.id,
      ]),
    ).toEqual([{ event: 'session.startedTrainee' }]);

    const applicationId = await submitApplication(trainee.client, field.id, 'MARKER-TRAINEE-NAME');
    expect(await ofRecord(admin.client, 'training_applications', applicationId)).toEqual([
      { event: 'application.createdWithStatus', params: { status: 'Submitted' } },
    ]);
    expect(
      await events(admin.client, "table_name = 'application_attachments' AND new_values ->> 'application_id' = $1", [
        applicationId,
      ]),
    ).toEqual([{ event: 'attachment.cv' }]);
    expect((await ofRecord(admin.client, 'trainees', trainee.user.id)).map((d) => d.event)).toEqual([
      'trainees.created',
      'trainee.profileRecorded',
    ]);
    const forHr = await events(
      admin.client,
      "table_name = 'notifications' AND new_values ->> 'entity_id' = $1 AND new_values ->> 'recipient_id' = $2",
      [applicationId, hr.user.id],
    );
    expect(forHr).toEqual([{ event: 'notification.createdApplicationSubmitted' }]);

    // HR: review, contact log, accept; another application rejected.
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/review`)).status).toBe(200);
    expect(
      (
        await hr.client.post(`/api/hr/applications/${applicationId}/contact-logs`, {
          contactDate: '2031-01-02',
          method: 'Phone',
          summary: 'MARKER-CONTACT-SUMMARY',
        })
      ).status,
    ).toBe(201);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    expect((await ofRecord(admin.client, 'training_applications', applicationId)).map((d) => d.event)).toEqual([
      'application.createdWithStatus',
      'application.underReview',
      'application.accepted',
    ]);
    expect(
      await events(admin.client, "table_name = 'contact_logs' AND new_values ->> 'application_id' = $1", [
        applicationId,
      ]),
    ).toEqual([{ event: 'contact_logs.created' }]);

    const other = await signInTrainee(api);
    const rejectedId = await submitApplication(other.client, field.id, 'MARKER-OTHER-NAME');
    await hr.client.post(`/api/hr/applications/${rejectedId}/reject`, { reason: 'MARKER-REJECTION-REASON' });
    expect((await ofRecord(admin.client, 'training_applications', rejectedId)).at(-1)).toEqual({
      event: 'application.rejected',
    });

    // Mentor request, HR approval (the assignment), a progress note, the employee reads the notification.
    const request = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', { applicationId, note: 'MARKER-MENTOR-NOTE' }),
    );
    expect(await ofRecord(admin.client, 'mentor_requests', request.id)).toEqual([{ event: 'mentor_requests.created' }]);
    expect(
      await events(
        admin.client,
        "table_name = 'notifications' AND new_values ->> 'entity_id' = $1 AND new_values ->> 'recipient_id' = $2",
        [request.id, hr.user.id],
      ),
    ).toEqual([{ event: 'notification.createdMentorRequestSubmitted' }]);
    const approved = await body<{ assignmentId: string }>(
      await hr.client.post(`/api/hr/mentor-requests/${request.id}/approve`, {
        startDate: '2031-02-01',
        endDate: '2031-04-30',
      }),
    );
    expect((await ofRecord(admin.client, 'mentor_requests', request.id)).at(-1)).toEqual({
      event: 'mentorRequest.approved',
    });
    expect(await ofRecord(admin.client, 'assignments', approved.assignmentId)).toEqual([
      { event: 'assignment.createdFromRequest' },
    ]);
    expect(
      (
        await employee.client.post(`/api/employee/assignments/${approved.assignmentId}/notes`, {
          text: 'MARKER-PROGRESS-NOTE',
        })
      ).status,
    ).toBe(201);
    expect(
      await events(admin.client, "table_name = 'progress_notes' AND new_values ->> 'assignment_id' = $1", [
        approved.assignmentId,
      ]),
    ).toEqual([{ event: 'progress_notes.created' }]);

    const [notificationId] = await auditIds(
      "table_name = 'notifications' AND new_values ->> 'entity_id' = $1 AND new_values ->> 'type' = 'MentorRequestApproved'",
      [request.id],
    );
    const notification = await withDb((db) =>
      db.query<{ entity_id: string }>('SELECT entity_id FROM audit_logs WHERE id = $1', [notificationId]),
    );
    expect(await describedAs(admin.client, notificationId!)).toMatchObject({
      description: { event: 'notification.createdMentorRequestApproved' },
    });
    const notificationRow = notification.rows[0]!.entity_id;
    expect((await employee.client.post(`/api/notifications/${notificationRow}/read`)).status).toBe(204);
    expect((await ofRecord(admin.client, 'notifications', notificationRow)).at(-1)).toEqual({
      event: 'notification.read',
    });

    // A second request, rejected.
    const third = await signInTrainee(api);
    const thirdApplication = await submitApplication(third.client, field.id);
    await hr.client.post(`/api/hr/applications/${thirdApplication}/accept`);
    const declined = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', { applicationId: thirdApplication, note: 'x' }),
    );
    await hr.client.post(`/api/hr/mentor-requests/${declined.id}/reject`);
    expect((await ofRecord(admin.client, 'mentor_requests', declined.id)).at(-1)).toEqual({
      event: 'mentorRequest.rejected',
    });
    expect(
      await events(
        admin.client,
        "table_name = 'notifications' AND new_values ->> 'entity_id' = $1 AND new_values ->> 'type' = 'MentorRequestRejected'",
        [declined.id],
      ),
    ).toEqual([{ event: 'notification.createdMentorRequestRejected' }]);

    // Privacy: no description carries anything stored, and nothing stored appears in the viewer's answers.
    const pages = await Promise.all(
      [hr.user.id, employee.user.id, trainee.user.id, other.user.id].map(async (actorId) =>
        body<{ entries: Entry[] }>(await admin.client.get(`/api/admin/audit-logs?actorId=${actorId}`)),
      ),
    );
    const everything = JSON.stringify(pages);
    for (const marker of [
      'MARKER-CONTACT-SUMMARY',
      'MARKER-REJECTION-REASON',
      'MARKER-MENTOR-NOTE',
      'MARKER-PROGRESS-NOTE',
    ]) {
      expect(everything).not.toContain(marker);
    }
    const descriptions = JSON.stringify(pages.flatMap((p) => p.entries.map((e) => e.description)));
    for (const secret of ['MARKER', trainee.email, other.email, 'cv.pdf', '@', field.name]) {
      expect(descriptions).not.toContain(secret);
    }
    for (const entry of pages.flatMap((p) => p.entries)) expect(AUDIT_EVENTS).toContain(entry.description.event);
  });

  it('accounts, roles, sessions and sign-in codes, including a change made directly in the database', async () => {
    const admin = await signInStaff(api, 'Admin');
    const staff = await signInStaff(api, 'Employee');
    expect(await ofRecord(admin.client, 'employees', staff.user.id)).toEqual([
      { event: 'employee.createdWithRole', params: { role: 'Employee' } },
    ]);
    expect(
      (
        await events(admin.client, "table_name = 'user_sessions' AND new_values ->> 'employee_id' = $1", [
          staff.user.id,
        ])
      )[0],
    ).toEqual({ event: 'session.startedStaff' });

    // By an Admin, then directly in the database (recorded as the Database, described the same way).
    expect((await admin.client.put(`/api/admin/users/${staff.user.id}/role`, { role: 'HR' })).status).toBe(200);
    await withDb((db) => db.query("UPDATE employees SET role = 'Employee' WHERE id = $1", [staff.user.id]));
    const [byAdmin, byDatabase] = await auditIds(
      "table_name = 'employees' AND entity_id = $1 AND operation = 'UPDATE'",
      [staff.user.id],
    );
    expect(await describedAs(admin.client, byAdmin!)).toMatchObject({
      actorType: 'Staff',
      description: { event: 'employee.roleChanged', params: { fromRole: 'Employee', toRole: 'HR' } },
    });
    expect(await describedAs(admin.client, byDatabase!)).toMatchObject({
      actorType: 'Database',
      description: { event: 'employee.roleChanged', params: { fromRole: 'HR', toRole: 'Employee' } },
    });

    // A second sign-in in the same browser replaces the first session; signing out ends the second.
    const again = await staff.client.post('/api/auth/staff/google', {
      idToken: await api.google.issue(staff.email, COMPANY_DOMAIN),
    });
    expect(again.status).toBe(200);
    expect((await staff.client.post('/api/auth/sign-out')).status).toBe(204);
    const sessionChanges = await events(
      admin.client,
      "table_name = 'user_sessions' AND operation = 'UPDATE' AND entity_id IN (SELECT id::text FROM user_sessions WHERE employee_id = $1)",
      [staff.user.id],
    );
    expect(sessionChanges).toEqual([{ event: 'session.replaced' }, { event: 'session.signedOut' }]);

    // An ordinary Google account (not staff): its session is identified by the account's own Google subject.
    const outsider = api.client();
    expect(
      (
        await outsider.post('/api/auth/staff/google', {
          idToken: await api.google.issue(uniqueEmail('gmail.example'), null),
        })
      ).status,
    ).toBe(200);
    const { id: googleId } = await body<{ id: string }>(await outsider.get('/api/auth/me'));
    expect(
      await events(admin.client, "table_name = 'user_sessions' AND new_values ->> 'google_subject' = $1", [
        googleId.replace(/^google:/, ''),
      ]),
    ).toEqual([{ event: 'session.startedGoogle' }]);

    // Trainee codes: a newer request replaces the first, a wrong code is counted, the right one is used.
    const email = uniqueEmail();
    const client = api.client();
    await client.post('/api/auth/trainee/request', { email });
    await client.post('/api/auth/trainee/request', { email });
    const { code } = api.emails.lastSignInFor(email);
    await client.post('/api/auth/trainee/verify', { email, code: code === '000000' ? '111111' : '000000' });
    expect((await client.post('/api/auth/trainee/verify', { email, code })).status).toBe(200);
    const codes = await events(
      admin.client,
      "table_name = 'trainee_sign_in_codes' AND entity_id IN (SELECT id::text FROM trainee_sign_in_codes WHERE email = $1)",
      [email],
    );
    expect(codes.map((d) => d.event)).toEqual([
      'trainee_sign_in_codes.created',
      'signInCode.superseded', // the first code is set aside before the new one is issued
      'trainee_sign_in_codes.created',
      'signInCode.failedAttempt',
      'signInCode.used',
    ]);

    // Evaluation criteria: added, then weight and order changed.
    const criterion = await body<{ id: string }>(
      await admin.client.post('/api/admin/evaluation-criteria', { name: 'MARKER-CRITERION', weight: 1, sortOrder: 1 }),
    );
    await admin.client.put(`/api/admin/evaluation-criteria/${criterion.id}`, {
      name: 'MARKER-CRITERION',
      weight: 2,
      sortOrder: 5,
    });
    expect(await ofRecord(admin.client, 'evaluation_criteria', criterion.id)).toEqual([
      { event: 'evaluation_criteria.created' },
      { event: 'criterion.changed', params: { changes: ['criterion.order', 'criterion.weight'] } },
    ]);
  });
});

describe('audit descriptions: facts read from stored rows of every shape (nothing written)', () => {
  it('describes certificate, settings, profile, session, assignment and legacy rows from the stored values', async () => {
    expect(
      await describedFrom(
        'certificate_templates',
        'UPDATE',
        { logo_image: null },
        {
          logo_image: { action: 'uploaded', bytes: 10, sha256: 'ab' },
          logo_content_type: 'image/png',
          updated_at: '2031-01-01T00:00:00Z',
        },
      ),
    ).toEqual({ event: 'certificate.logoUploaded' });
    expect(
      await describedFrom(
        'certificate_templates',
        'UPDATE',
        { signature_image: { bytes: 1 } },
        {
          signature_image: { action: 'removed' },
          signature_content_type: null,
          updated_at: '2031-01-01T00:00:00Z',
        },
      ),
    ).toEqual({ event: 'certificate.signatureRemoved' });
    expect(
      await describedFrom('certificate_templates', 'UPDATE', { settings: {} }, { settings: { a: 1 }, updated_at: 'x' }),
    ).toEqual({ event: 'certificate.settingsChanged' });
    expect(await describedFrom('certificate_templates', 'INSERT', undefined, { id: 1, settings: {} })).toEqual({
      event: 'certificate_templates.created',
    });
    expect(
      await describedFrom(
        'notification_settings',
        'UPDATE',
        { late_evaluation_reminder_days: 3, training_ending_notice_days: 7 },
        { late_evaluation_reminder_days: 4, training_ending_notice_days: 8 },
      ),
    ).toEqual({
      event: 'intervals.changed',
      params: { changes: ['intervals.lateEvaluation', 'intervals.trainingEnding'] },
    });
    expect(
      await describedFrom('trainees', 'UPDATE', { full_name: 'Old', phone: null }, { full_name: 'New', phone: '1' }),
    ).toEqual({ event: 'trainees.updated' }); // a profile that was not empty: no claim that it was first recorded
    expect(await describedFrom('trainees', 'INSERT', undefined, { id: 'x', email: 'legacy@uni.example' })).toEqual({
      event: 'trainees.created',
    }); // the early two-column shape
    expect(
      await describedFrom('assignments', 'UPDATE', { status: 'Active' }, { status: 'Completed', end_reason: 'secret' }),
    ).toEqual({
      event: 'assignment.statusChanged',
      params: { fromAssignmentStatus: 'Active', toAssignmentStatus: 'Completed' },
    });
    expect(await describedFrom('assignments', 'INSERT', undefined, { id: 'x', mentor_request_id: null })).toEqual({
      event: 'assignment.createdDirect',
    });
    expect(await describedFrom('fields', 'INSERT', undefined, { id: 'x', is_active: false })).toEqual({
      event: 'field.createdInactive',
    });
  });

  it('falls back on unexpected, malformed and unknown records', async () => {
    expect(await describedFrom('employees', 'UPDATE', { role: 'HR' }, { role: 'Owner' })).toEqual({
      event: 'employees.updated',
    });
    expect(await describedFrom('employees', 'UPDATE', { full_name: 'a' }, { full_name: 'b' })).toEqual({
      event: 'employees.updated',
    });
    expect(await describedFrom('training_applications', 'INSERT', undefined, ['not', 'an', 'object'])).toEqual({
      event: 'training_applications.created',
    });
    expect(await describedFrom('training_applications', 'UPDATE', null, 'text')).toEqual({
      event: 'training_applications.updated',
    });
    expect(
      await describedFrom('user_sessions', 'UPDATE', { revoked_at: null }, { revoked_at: 'x', expires_at: 'y' }),
    ).toEqual({
      event: 'user_sessions.updated',
    });
    expect(await describedFrom('a_future_table', 'UPDATE', { a: 1 }, { a: 2 })).toEqual({ event: 'other.updated' });
    expect(await describedFrom('fields', 'DELETE', null, {})).toEqual({ event: 'unknown' });
  });

  it('reads nothing personal or secret from the stored values', async () => {
    const secrets = {
      email: 'secret-person@uni.example',
      full_name: 'Secret Person',
      phone: '000-SECRET',
      note: 'SECRET-NOTE',
      summary: 'SECRET-SUMMARY',
      text: 'SECRET-TEXT',
      rejection_reason: 'SECRET-REASON',
      file_name: 'secret-cv.pdf',
      storage_key: 'SECRET-KEY',
      sha256: 'SECRET-HASH',
      code_hash: 'SECRET-CODE-HASH',
      token_hash: 'SECRET-TOKEN-HASH',
      google_subject: 'SECRET-SUBJECT',
      name: 'SECRET-NAME',
      description: 'SECRET-DESCRIPTION',
    };
    const all: unknown[] = [];
    for (const table of [...AUDITED_TABLES, 'a_future_table']) {
      for (const operation of ['INSERT', 'UPDATE']) {
        all.push(
          await factsOf(table, operation, operation === 'UPDATE' ? secrets : undefined, { ...secrets, status: 'x' }),
        );
      }
    }
    const text = JSON.stringify(all);
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
  });
});

describe('audit descriptions: describeAudit itself', () => {
  it('always returns an event from the catalog, whatever it is given', () => {
    const odd = [null, undefined, 'x', 42, [], {}, { changed: 'status' }, { changed: [1, 2] }, { newStatus: 7 }];
    for (const table of [...AUDITED_TABLES, '', 'x']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE', '']) {
        for (const facts of odd) {
          const result = describeAudit(table, operation, facts);
          expect(AUDIT_EVENTS).toContain(result.event);
        }
      }
    }
  });

  it('only says what the facts show', () => {
    // An accepted application must have been in a known state before.
    expect(describeAudit('training_applications', 'UPDATE', { changed: ['status'], newStatus: 'Accepted' })).toEqual({
      event: 'training_applications.updated',
    });
    expect(
      describeAudit('training_applications', 'UPDATE', {
        changed: ['status'],
        oldStatus: 'Submitted',
        newStatus: 'Accepted',
      }),
    ).toEqual({ event: 'application.accepted' });
    // A role "change" to the same role, or from an unknown one, is not described as a change.
    expect(describeAudit('employees', 'UPDATE', { changed: ['role'], oldRole: 'HR', newRole: 'HR' })).toEqual({
      event: 'employees.updated',
    });
    // A criterion update touching an unknown column is not narrowed to the known ones.
    expect(describeAudit('evaluation_criteria', 'UPDATE', { changed: ['weight', 'secret'] })).toEqual({
      event: 'evaluation_criteria.updated',
    });
    // A notification marked unread is not "marked as read".
    expect(describeAudit('notifications', 'UPDATE', { changed: ['is_read'], read: 'false' })).toEqual({
      event: 'notifications.updated',
    });
    // Several code columns at once: no single cause is claimed.
    expect(describeAudit('trainee_sign_in_codes', 'UPDATE', { changed: ['failed_attempts', 'used_at'] })).toEqual({
      event: 'trainee_sign_in_codes.updated',
    });
  });

  it('describes every audit entry in this database (written by all test files) without an unknown or other event', async () => {
    const { rows } = await withDb((db) =>
      db.query<{ table_name: string; operation: string; facts: unknown }>(
        `SELECT a.table_name, a.operation, ${AUDIT_FACTS_SQL} AS facts FROM audit_logs a`,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const { event } = describeAudit(row.table_name, row.operation, row.facts);
      expect(AUDIT_EVENTS).toContain(event);
      counts.set(event, (counts.get(event) ?? 0) + 1);
    }
    expect([...counts.keys()].filter((e) => e === 'unknown' || e.startsWith('other.'))).toEqual([]);
  });
});

describe('audit descriptions: Arabic and English texts', () => {
  const lookup = (raw: string, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], JSON.parse(raw));

  it.each([
    ['en', enMessages],
    ['ar', arMessages],
  ])(
    '%s has a sentence for every event, with exactly its parameters, and every property and fallback label',
    (_l, raw) => {
      for (const event of AUDIT_EVENTS) {
        const text = lookup(raw, `admin.auditLog.events.${event}`);
        expect(typeof text, event).toBe('string');
        expect((text as string).trim(), event).not.toBe('');
        const placeholders = [...(text as string).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
        expect(placeholders, event).toEqual([...(AUDIT_EVENT_PARAMS[event] ?? [])].sort());
      }
      for (const property of [
        'criterion.name',
        'criterion.weight',
        'criterion.order',
        'intervals.trainingEnding',
        'intervals.lateEvaluation',
        'intervals.pendingRequest',
      ]) {
        expect(typeof lookup(raw, `admin.auditLog.properties.${property}`), property).toBe('string');
      }
      for (const key of ['tables.other', 'operations.other', 'descriptionColumn', 'listSeparator']) {
        expect(typeof lookup(raw, `admin.auditLog.${key}`), key).toBe('string');
      }
    },
  );
});
