import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/config';
import { body, createTestApi, setRole, signInStaff, signInTrainee, type TestClient, unique, withDb } from './helpers';

/**
 * The trainee lifecycle as far as the Employee area needs it (PDF §3, §4; owner decisions 2026-10-29): a trainee
 * applies, HR reviews and accepts, the trainee becomes available to employees, an employee asks to train them, HR
 * approves with dates (the assignment), and the employee keeps periodic notes. Real endpoints and a real database
 * (no shortcuts), files in the simulated private R2 bucket.
 */
const api = createTestApi();

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // "%PDF-1.7\n"

async function newField(admin: TestClient, isActive = true) {
  const field = await body<{ id: string; name: string }>(
    await admin.post('/api/admin/fields', { name: unique('Field'), description: null }),
  );
  if (!isActive)
    await admin.put(`/api/admin/fields/${field.id}`, { name: field.name, description: null, isActive: false });
  return field;
}

function applicationForm(fieldId: string, overrides: Record<string, string | File[] | null> = {}) {
  const values: Record<string, string | File[] | null> = {
    fullName: 'Lina Haddad',
    phone: '000-0000',
    university: 'Example University',
    major: 'Computer Engineering',
    studyYear: 'Fourth year',
    fieldId,
    availableFrom: '2027-02-01',
    availableTo: '2027-04-30',
    hours: '240',
    mandatoryForUniversity: 'true',
    cv: [new File([PDF], 'lina-cv.pdf', { type: 'application/pdf' })],
    letters: [new File([new TextEncoder().encode('letter')], 'letter.txt', { type: 'text/plain' })],
    ...overrides,
  };
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) {
    if (value === null) continue;
    if (Array.isArray(value)) value.forEach((file) => form.append(name, file));
    else form.append(name, value);
  }
  return form;
}

/** Shared cast: Admin (fields), HR and an employee, each signed in through the real Google flow. */
async function cast() {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const field = await newField(admin.client);
  return { admin, hr, employee, field };
}

/** A trainee who applied, and HR's acceptance through the real endpoints. */
async function acceptedTrainee(
  hr: TestClient,
  fieldId: string,
  overrides: Record<string, string | File[] | null> = {},
) {
  const trainee = await signInTrainee(api);
  const submitted = await trainee.client.post('/api/trainee/applications', applicationForm(fieldId, overrides));
  expect(submitted.status).toBe(201);
  const { id } = await body<{ id: string }>(submitted);
  expect((await hr.post(`/api/hr/applications/${id}/accept`)).status).toBe(200);
  return { ...trainee, applicationId: id };
}

const audit = (entityId: string) =>
  withDb((db) =>
    db.query<{ table_name: string; operation: string; actor_type: string; actor_id: string | null }>(
      'SELECT table_name, operation, actor_type, actor_id FROM audit_logs WHERE entity_id = $1 ORDER BY id',
      [entityId],
    ),
  ).then((r) => r.rows);

describe('the lifecycle from application to periodic notes', () => {
  it('runs through the real endpoints, with each decision by the right role and audited', async () => {
    const { hr, employee, field } = await cast();
    const trainee = await signInTrainee(api);
    const emailsBefore = api.emails.sent.length;

    // 1. The trainee applies with the PDF §4 form, a CV and a university letter.
    const submitted = await trainee.client.post('/api/trainee/applications', applicationForm(field.id));
    expect(submitted.status).toBe(201);
    const { id: applicationId } = await body<{ id: string }>(submitted);
    const board = await body<{ id: string; status: string; attachments: { kind: string; fileName: string }[] }[]>(
      await trainee.client.get('/api/trainee/applications'),
    );
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ id: applicationId, status: 'Submitted' });
    expect(board[0]!.attachments.map((a) => [a.kind, a.fileName])).toEqual([
      ['Cv', 'lina-cv.pdf'],
      ['UniversityLetter', 'letter.txt'],
    ]);
    expect(await body(await trainee.client.get('/api/trainee/profile'))).toMatchObject({
      fullName: 'Lina Haddad',
      university: 'Example University',
      studyYear: 'Fourth year',
    });
    expect(api.emails.sent.length).toBe(emailsBefore); // nothing is e-mailed

    // 2. Not available to employees before HR accepts.
    const available = async (query = '') =>
      body<{ applicationId: string }[]>(await employee.client.get(`/api/employee/available-trainees${query}`));
    expect((await available()).map((t) => t.applicationId)).not.toContain(applicationId);

    // 3. HR reviews, then accepts (decision 1 of 2).
    expect(await body(await hr.client.post(`/api/hr/applications/${applicationId}/review`))).toMatchObject({
      status: 'UnderReview',
    });
    expect(await body(await hr.client.post(`/api/hr/applications/${applicationId}/accept`))).toMatchObject({
      status: 'Accepted',
    });
    const listed = (await available(`?fieldId=${field.id}`)).find((t) => t.applicationId === applicationId);
    expect(listed).toMatchObject({
      trainee: { fullName: 'Lina Haddad', university: 'Example University', major: 'Computer Engineering' },
      field: { id: field.id },
      availableFrom: '2027-02-01',
      availableTo: '2027-04-30',
      hours: 240,
      mandatoryForUniversity: true,
      hasCv: true,
    });
    expect(listed).not.toHaveProperty('trainee.email'); // contact details stay with HR

    // 4. The employee opens the CV through a temporary link.
    const link = await body<{ url: string }>(
      await employee.client.post(`/api/employee/applications/${applicationId}/cv-link`),
    );
    const file = await employee.client.get(link.url);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('content-disposition')).toContain('inline; filename="lina-cv.pdf"');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(file.headers.get('cache-control')).toBe('private, no-store');

    // 5. "I want to train them": recorded for this employee, waiting for HR. The request alone changes nothing else:
    //    the trainee stays on the available list until HR approves an assignment (PDF §4: "not yet assigned").
    const requested = await employee.client.post('/api/employee/mentor-requests', {
      applicationId,
      note: 'Build the reporting API together',
    });
    expect(requested.status).toBe(201);
    const { id: requestId } = await body<{ id: string }>(requested);
    expect((await available()).map((t) => t.applicationId)).toContain(applicationId);
    expect(await body(await employee.client.get('/api/employee/mentor-requests'))).toEqual([
      expect.objectContaining({
        id: requestId,
        status: 'Pending',
        note: 'Build the reporting API together',
        traineeName: 'Lina Haddad',
        applicationId,
      }),
    ]);
    expect(await body(await employee.client.get('/api/employee/trainees'))).toEqual([]); // nothing started yet

    // 6. HR approves the assignment with its dates (decision 2 of 2): the training starts.
    const pending = await body<{ id: string }[]>(await hr.client.get('/api/hr/mentor-requests?status=Pending'));
    expect(pending.map((r) => r.id)).toContain(requestId);
    const approved = await hr.client.post(`/api/hr/mentor-requests/${requestId}/approve`, {
      startDate: '2027-02-03',
      endDate: '2027-04-28',
    });
    expect(approved.status).toBe(200);
    const { assignmentId } = await body<{ assignmentId: string; status: string }>(approved);

    // 7. My trainees, and a periodic note.
    expect(await body(await employee.client.get('/api/employee/trainees'))).toEqual([
      expect.objectContaining({
        id: assignmentId,
        status: 'Active',
        startDate: '2027-02-03',
        endDate: '2027-04-28',
        trainee: expect.objectContaining({ fullName: 'Lina Haddad' }),
        fieldName: field.name,
      }),
    ]);
    const note = await employee.client.post(`/api/employee/assignments/${assignmentId}/notes`, {
      text: 'Finished the onboarding tasks.',
    });
    expect(note.status).toBe(201);
    const notes = await body<{ id: string; text: string; authorName: string }[]>(
      await employee.client.get(`/api/employee/assignments/${assignmentId}/notes`),
    );
    expect(notes.map((n) => n.text)).toEqual(['Finished the onboarding tasks.']);

    // 8. The audit log records each step with the right actor.
    expect(await audit(applicationId)).toEqual([
      { table_name: 'training_applications', operation: 'INSERT', actor_type: 'Trainee', actor_id: trainee.user.id },
      { table_name: 'training_applications', operation: 'UPDATE', actor_type: 'Staff', actor_id: hr.user.id },
      { table_name: 'training_applications', operation: 'UPDATE', actor_type: 'Staff', actor_id: hr.user.id },
    ]);
    expect(await audit(requestId)).toEqual([
      { table_name: 'mentor_requests', operation: 'INSERT', actor_type: 'Staff', actor_id: employee.user.id },
      { table_name: 'mentor_requests', operation: 'UPDATE', actor_type: 'Staff', actor_id: hr.user.id },
    ]);
    expect(await audit(assignmentId)).toEqual([
      { table_name: 'assignments', operation: 'INSERT', actor_type: 'Staff', actor_id: hr.user.id },
    ]);
    const noteId = (await body<{ id: string }>(note)).id;
    expect(await audit(noteId)).toEqual([
      { table_name: 'progress_notes', operation: 'INSERT', actor_type: 'Staff', actor_id: employee.user.id },
    ]);
    expect(api.emails.sent.length).toBe(emailsBefore); // still nothing e-mailed
  });
});

describe('who may do what', () => {
  const TRAINEE = [
    'GET /api/trainee/fields',
    'GET /api/trainee/profile',
    'GET /api/trainee/applications',
    'POST /api/trainee/applications',
  ];
  const HR = [
    'GET /api/hr/applications',
    'GET /api/hr/mentor-requests',
    `GET /api/hr/applications/${crypto.randomUUID()}/contact-logs`,
    `POST /api/hr/applications/${crypto.randomUUID()}/contact-logs`,
  ];
  const EMPLOYEE = [
    'GET /api/employee/fields',
    'GET /api/employee/available-trainees',
    'GET /api/employee/mentor-requests',
    'GET /api/employee/trainees',
  ];
  const call = (client: TestClient, endpoint: string) => {
    const [method, path] = endpoint.split(' ') as [string, string];
    return client.request(method, path, method === 'POST' ? new FormData() : undefined);
  };

  it('each area is closed to signed-out visitors and to every other role', async () => {
    const roles = {
      Trainee: (await signInTrainee(api)).client,
      HR: (await signInStaff(api, 'HR')).client,
      Employee: (await signInStaff(api, 'Employee')).client,
      Admin: (await signInStaff(api, 'Admin')).client,
    };
    const signedOut = api.client();
    for (const [area, endpoints] of [
      ['Trainee', TRAINEE],
      ['HR', HR],
      ['Employee', EMPLOYEE],
    ] as const) {
      for (const endpoint of endpoints) {
        expect((await call(signedOut, endpoint)).status, `${endpoint} signed out`).toBe(401);
        for (const [role, client] of Object.entries(roles)) {
          if (role === area) continue;
          expect((await call(client, endpoint)).status, `${endpoint} as ${role}`).toBe(403);
        }
      }
    }
  });

  it('an employee cannot approve or reject any request, including their own; only HR decides', async () => {
    const { hr, employee, field } = await cast();
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const { id } = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', { applicationId, note: 'Mobile app' }),
    );

    for (const action of ['approve', 'reject']) {
      const attempt = await employee.client.post(`/api/hr/mentor-requests/${id}/${action}`, {
        startDate: '2027-02-01',
        endDate: '2027-03-01',
      });
      expect(attempt.status).toBe(403);
    }
    expect((await employee.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(403);
    const mine = await body<{ id: string; status: string }[]>(
      await employee.client.get('/api/employee/mentor-requests'),
    );
    expect(mine.find((r) => r.id === id)!.status).toBe('Pending');
    expect(await body(await employee.client.get('/api/employee/trainees'))).toEqual([]);
  });
});

describe('applications', () => {
  it('checks the PDF form: required profile, active field, a valid period, positive hours and a CV', async () => {
    const { admin, field } = await cast();
    const inactive = await newField(admin.client, false);
    const trainee = await signInTrainee(api);
    // Same session from a new client address each time, so these many attempts stay under the rate limit.
    const submit = (overrides: Record<string, string | File[] | null>) => {
      const client = api.client();
      trainee.client.cookies.forEach((value, name) => client.cookies.set(name, value));
      return client.post('/api/trainee/applications', applicationForm(field.id, overrides));
    };

    for (const [overrides, code] of [
      [{ fullName: ' ' }, 'validation.required'],
      [{ university: null }, 'validation.required'],
      [{ fieldId: inactive.id }, 'application.field_unavailable'],
      [{ fieldId: 'not-a-guid' }, 'validation.required'],
      [{ availableTo: '2027-01-01' }, 'application.invalid_period'],
      [{ availableFrom: '2027-02-30' }, 'validation.required'],
      [{ hours: '0' }, 'validation.range'],
      [{ hours: '1.5' }, 'validation.range'],
      [{ mandatoryForUniversity: 'maybe' }, 'validation.required'],
      [{ cv: null }, 'application.cv_required'],
    ] as const) {
      const response = await submit(overrides as Record<string, string | File[] | null>);
      expect(response.status, JSON.stringify(overrides)).toBe(400);
      expect((await body(response)).code, JSON.stringify(overrides)).toBe(code);
    }
    expect((await trainee.client.post('/api/trainee/applications', { fieldId: field.id })).status).toBe(415);
    expect(await body(await trainee.client.get('/api/trainee/applications'))).toEqual([]);

    // No file-type rule (owner decision): any CV file is accepted; a university letter is optional.
    const doc = new File([new TextEncoder().encode('cv')], 'cv.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect((await submit({ cv: [doc], letters: null })).status).toBe(201);
  });

  it('the first application records the profile; a later one never overwrites it', async () => {
    const { field } = await cast();
    const trainee = await signInTrainee(api);
    expect((await trainee.client.post('/api/trainee/applications', applicationForm(field.id))).status).toBe(201);
    const second = await trainee.client.post(
      '/api/trainee/applications',
      applicationForm(field.id, { fullName: 'Someone Else', university: 'Another University', phone: null }),
    );
    expect(second.status).toBe(201); // a later form's profile fields are not used (or needed)
    expect(await body(await trainee.client.get('/api/trainee/profile'))).toMatchObject({
      fullName: 'Lina Haddad',
      university: 'Example University',
      phone: '000-0000',
    });
    expect(await body<unknown[]>(await trainee.client.get('/api/trainee/applications'))).toHaveLength(2);
  });

  it('a trainee sees and opens only their own applications and files', async () => {
    const { field } = await cast();
    const lina = await signInTrainee(api);
    const omar = await signInTrainee(api);
    await lina.client.post('/api/trainee/applications', applicationForm(field.id));
    const linaBoard = await body<{ attachments: { id: string }[] }[]>(
      await lina.client.get('/api/trainee/applications'),
    );
    const linaCv = linaBoard[0]!.attachments[0]!.id;

    expect(await body(await omar.client.get('/api/trainee/applications'))).toEqual([]);
    expect((await omar.client.post(`/api/trainee/attachments/${linaCv}/link`)).status).toBe(404);
    const linaLink = await body<{ url: string }>(await lina.client.post(`/api/trainee/attachments/${linaCv}/link`));
    expect((await lina.client.get(linaLink.url)).status).toBe(200);
    expect((await omar.client.get(linaLink.url)).status).toBe(404); // a link works only for its own user
  });

  it('HR reviews explicitly, decides from Submitted or Under Review, needs a reason to reject, and decisions are final', async () => {
    const { hr, field } = await cast();
    const apply = async () => {
      const trainee = await signInTrainee(api);
      return (
        await body<{ id: string }>(await trainee.client.post('/api/trainee/applications', applicationForm(field.id)))
      ).id;
    };
    const post = (id: string, action: string, payload?: unknown) =>
      hr.client.post(`/api/hr/applications/${id}/${action}`, payload);

    const direct = await apply();
    expect((await post(direct, 'reject', { reason: ' ' })).status).toBe(400);
    expect(await body(await post(direct, 'reject', { reason: 'The requested period is fully booked.' }))).toMatchObject(
      {
        status: 'Rejected',
        rejectionReason: 'The requested period is fully booked.',
      },
    );
    for (const action of ['review', 'accept']) {
      const again = await post(direct, action, { reason: 'x' });
      expect(again.status, action).toBe(400);
      expect((await body(again)).code).toBe('application.invalid_status');
    }

    const reviewed = await apply();
    expect((await post(reviewed, 'review')).status).toBe(200);
    expect((await post(reviewed, 'review')).status).toBe(400);
    expect(await body(await post(reviewed, 'accept'))).toMatchObject({ status: 'Accepted', rejectionReason: null });
    expect((await post(reviewed, 'reject', { reason: 'Too late' })).status).toBe(400);

    expect((await post(crypto.randomUUID(), 'accept')).status).toBe(404);
    const rows = await withDb((db) =>
      db.query<{ status: string }>(
        'SELECT status FROM training_applications WHERE id = ANY($1) ORDER BY submitted_at',
        [[direct, reviewed]],
      ),
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['Rejected', 'Accepted']); // kept on record, never deleted
  });

  it('two HR decisions at the same moment: exactly one wins', async () => {
    const { hr, field } = await cast();
    const hr2 = await signInStaff(api, 'HR');
    const trainee = await signInTrainee(api);
    const { id } = await body<{ id: string }>(
      await trainee.client.post('/api/trainee/applications', applicationForm(field.id)),
    );
    const results = await Promise.all([
      hr.client.post(`/api/hr/applications/${id}/accept`),
      hr2.client.post(`/api/hr/applications/${id}/reject`, { reason: 'Duplicate' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('contact log (PDF §4, §8)', () => {
  it('HR records calls and verbal agreements with date, method and summary; decisions do not depend on it', async () => {
    const { hr, field } = await cast();
    const trainee = await signInTrainee(api);
    const { id } = await body<{ id: string }>(
      await trainee.client.post('/api/trainee/applications', applicationForm(field.id)),
    );
    const log = (payload: unknown) => hr.client.post(`/api/hr/applications/${id}/contact-logs`, payload);

    const first = await log({ contactDate: '2026-10-28', method: 'Phone', summary: 'Agreed on the period.' });
    expect(first.status).toBe(201);
    expect((await log({ contactDate: '2026-10-29', method: 'Meeting', summary: 'Met at the office.' })).status).toBe(
      201,
    );
    for (const invalid of [
      { contactDate: '2026-10-29', method: 'Fax', summary: 'x' },
      { contactDate: '2026-02-30', method: 'Email', summary: 'x' },
      { contactDate: '2026-10-29', method: 'Email', summary: ' ' },
      { method: 'Email', summary: 'x' },
    ]) {
      expect((await log(invalid)).status, JSON.stringify(invalid)).toBe(400);
    }
    expect(
      (
        await hr.client.post(`/api/hr/applications/${crypto.randomUUID()}/contact-logs`, {
          contactDate: '2026-10-29',
          method: 'Email',
          summary: 'x',
        })
      ).status,
    ).toBe(404);

    const entries = await body<{ contactDate: string; method: string; summary: string; authorName: string }[]>(
      await hr.client.get(`/api/hr/applications/${id}/contact-logs`),
    );
    expect(entries.map((e) => [e.contactDate, e.method, e.summary])).toEqual([
      ['2026-10-29', 'Meeting', 'Met at the office.'],
      ['2026-10-28', 'Phone', 'Agreed on the period.'],
    ]);
    expect(entries[0]!.authorName).toBeTruthy();
    expect(await audit((await body<{ id: string }>(first)).id)).toEqual([
      { table_name: 'contact_logs', operation: 'INSERT', actor_type: 'Staff', actor_id: hr.user.id },
    ]);

    // No minimum number of entries: an application without any can still be decided.
    const other = await signInTrainee(api);
    const { id: unlogged } = await body<{ id: string }>(
      await other.client.post('/api/trainee/applications', applicationForm(field.id)),
    );
    expect((await hr.client.post(`/api/hr/applications/${unlogged}/accept`)).status).toBe(200);
  });
});

describe('available trainees and mentor requests', () => {
  it('lists accepted, not-yet-assigned trainees, and filters by field, university and period', async () => {
    const { admin, hr, employee } = await cast();
    const backend = await newField(admin.client);
    const qa = await newField(admin.client);
    const najah = await acceptedTrainee(hr.client, backend.id, { university: 'An-Example National University' });
    const other = await acceptedTrainee(hr.client, qa.id, {
      university: 'Other Example College',
      availableFrom: '2027-07-01',
      availableTo: '2027-08-31',
    });
    const submittedOnly = await signInTrainee(api);
    const { id: notAccepted } = await body<{ id: string }>(
      await submittedOnly.client.post('/api/trainee/applications', applicationForm(backend.id)),
    );

    const ids = async (query: string) =>
      (
        await body<{ applicationId: string }[]>(await employee.client.get(`/api/employee/available-trainees${query}`))
      ).map((t) => t.applicationId);
    const all = await ids('');
    expect(all).toEqual(expect.arrayContaining([najah.applicationId, other.applicationId]));
    expect(all).not.toContain(notAccepted);

    expect(await ids(`?fieldId=${backend.id}`)).toEqual([najah.applicationId]);
    expect(await ids(`?fieldId=${qa.id}&university=other example`)).toEqual([other.applicationId]);
    expect(await ids(`?fieldId=${qa.id}&university=najah`)).toEqual([]);
    // Period: trainees whose available period overlaps the one asked for.
    expect(await ids(`?fieldId=${qa.id}&from=2027-08-01&to=2027-09-30`)).toEqual([other.applicationId]);
    expect(await ids(`?fieldId=${qa.id}&from=2027-01-01&to=2027-06-30`)).toEqual([]);
    expect(await ids(`?fieldId=${backend.id}&to=2027-02-01`)).toEqual([najah.applicationId]);
  });

  it('a pending request hides no one: several employees may ask for the same trainee until HR assigns one', async () => {
    const { hr, employee, field } = await cast();
    const colleague = await signInStaff(api, 'Employee');
    const third = await signInStaff(api, 'Employee');
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const request = (client: TestClient, note = 'Data pipeline') =>
      client.post('/api/employee/mentor-requests', { applicationId, note });
    const listed = async (client: TestClient) =>
      (await body<{ applicationId: string }[]>(await client.get('/api/employee/available-trainees'))).map(
        (t) => t.applicationId,
      );

    expect((await request(employee.client, ' ')).status).toBe(400); // the note is required
    const both = await Promise.all([request(employee.client), request(colleague.client)]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(await listed(third.client)).toContain(applicationId); // still available to everyone while pending

    const [mine, theirs] = await Promise.all(both.map((r) => body<{ id: string }>(r)));
    expect((await hr.client.post(`/api/hr/mentor-requests/${mine!.id}/reject`)).status).toBe(200);
    expect(
      (
        await hr.client.post(`/api/hr/mentor-requests/${mine!.id}/approve`, {
          startDate: '2027-02-01',
          endDate: '2027-03-01',
        })
      ).status,
    ).toBe(400); // already decided
    expect(await listed(third.client)).toContain(applicationId);

    // HR assigns the trainee: from then on they are no longer available (PDF §4), and new requests are refused.
    expect(
      (
        await hr.client.post(`/api/hr/mentor-requests/${theirs!.id}/approve`, {
          startDate: '2027-02-01',
          endDate: '2027-03-31',
        })
      ).status,
    ).toBe(200);
    expect(await listed(third.client)).not.toContain(applicationId);
    expect((await body(await request(third.client))).code).toBe('mentor_request.not_available');
  });

  it('a trainee whose application is not accepted cannot be requested', async () => {
    const { employee, field } = await cast();
    const trainee = await signInTrainee(api);
    const { id } = await body<{ id: string }>(
      await trainee.client.post('/api/trainee/applications', applicationForm(field.id)),
    );
    const response = await employee.client.post('/api/employee/mentor-requests', { applicationId: id, note: 'Hi' });
    expect((await body(response)).code).toBe('mentor_request.not_available');
  });

  it('an assignment that ended does not bring the trainee back to the available list', async () => {
    const { hr, employee, field } = await cast();
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const { id } = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', { applicationId, note: 'Testing' }),
    );
    const { assignmentId } = await body<{ assignmentId: string }>(
      await hr.client.post(`/api/hr/mentor-requests/${id}/approve`, { startDate: '2027-02-01', endDate: '2027-03-31' }),
    );
    // Set directly: ending a training is an HR feature that is not built yet.
    for (const status of ['Completed', 'EndedEarly', 'Withdrawn', 'Transferred']) {
      await withDb((db) => db.query('UPDATE assignments SET status = $2 WHERE id = $1', [assignmentId, status]));
      const listed = await body<{ applicationId: string }[]>(
        await employee.client.get('/api/employee/available-trainees'),
      );
      expect(
        listed.map((t) => t.applicationId),
        status,
      ).not.toContain(applicationId);
    }
  });

  it('HR approval needs a valid period and makes the trainee unavailable; a second approval is impossible', async () => {
    const { hr, employee, field } = await cast();
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const { id } = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', { applicationId, note: 'Testing' }),
    );
    const approve = (startDate: string, endDate: string) =>
      hr.client.post(`/api/hr/mentor-requests/${id}/approve`, { startDate, endDate });

    expect((await approve('2027-03-01', '2027-02-01')).status).toBe(400);
    expect((await approve('2027-02-30', '2027-03-01')).status).toBe(400);
    expect((await approve('2027-02-01', '2027-03-31')).status).toBe(200);
    expect((await approve('2027-02-01', '2027-03-31')).status).toBe(400);
    const listed = await body<{ applicationId: string }[]>(
      await employee.client.get('/api/employee/available-trainees'),
    );
    expect(listed.map((t) => t.applicationId)).not.toContain(applicationId);
  });
});

describe('CV access', () => {
  it("temporary links: their own user only, short-lived, checked again; letters are HR's", async () => {
    const { admin, hr, employee, field } = await cast();
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const colleague = await signInStaff(api, 'Employee');

    const link = await body<{ url: string; expiresAt: string }>(
      await employee.client.post(`/api/employee/applications/${applicationId}/cv-link`),
    );
    expect((await colleague.client.get(link.url)).status).toBe(404); // not their link
    expect((await admin.client.get(link.url)).status).toBe(404);
    expect((await api.client().get(link.url)).status).toBe(401);
    expect((await employee.client.get(`${link.url}x`)).status).toBe(404); // tampered
    api.clock.advanceMinutes(5);
    try {
      expect((await employee.client.get(link.url)).status).toBe(404); // expired
    } finally {
      api.clock.offsetMs = 0;
    }

    const detail = await body<{ attachments: { id: string; kind: string }[] }>(
      await hr.client.get(`/api/hr/applications/${applicationId}`),
    );
    const letter = detail.attachments.find((a) => a.kind === 'UniversityLetter')!;
    const hrLink = await body<{ url: string }>(await hr.client.post(`/api/hr/attachments/${letter.id}/link`));
    expect((await hr.client.get(hrLink.url)).status).toBe(200);
    expect((await employee.client.post(`/api/hr/attachments/${letter.id}/link`)).status).toBe(403);
  });

  it('asking to train a trainee, or being assigned them, does not take the CV away; unrelated employees lose it once assigned', async () => {
    const { hr, field } = await cast();
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const mentor = await signInStaff(api, 'Employee');
    const stillWaiting = await signInStaff(api, 'Employee');
    const refused = await signInStaff(api, 'Employee');
    const unrelated = await signInStaff(api, 'Employee');
    const cv = async (client: TestClient) => {
      const issued = await client.post(`/api/employee/applications/${applicationId}/cv-link`);
      if (issued.status !== 200) return issued.status;
      return (await client.get((await body<{ url: string }>(issued)).url)).status;
    };
    const ask = async (client: TestClient) =>
      (await body<{ id: string }>(await client.post('/api/employee/mentor-requests', { applicationId, note: 'Mine' })))
        .id;

    const mentorRequest = await ask(mentor.client);
    await ask(stillWaiting.client);
    const refusedRequest = await ask(refused.client);
    expect(await cv(mentor.client)).toBe(200); // a pending request keeps the CV
    expect(await cv(unrelated.client)).toBe(200); // still available to every employee
    const earlier = await body<{ url: string }>(
      await unrelated.client.post(`/api/employee/applications/${applicationId}/cv-link`),
    );

    await hr.client.post(`/api/hr/mentor-requests/${refusedRequest}/reject`);
    await hr.client.post(`/api/hr/mentor-requests/${mentorRequest}/approve`, {
      startDate: '2027-02-01',
      endDate: '2027-03-31',
    });

    expect(await cv(mentor.client)).toBe(200); // their assigned trainee
    expect(await cv(stillWaiting.client)).toBe(200); // their request is still waiting for HR
    expect(await cv(refused.client)).toBe(404); // no longer related: request rejected, trainee assigned elsewhere
    expect(await cv(unrelated.client)).toBe(404);
    expect((await unrelated.client.get(earlier.url)).status).toBe(404); // an earlier link is checked again
  });
});

describe('my trainees and periodic notes', () => {
  async function assigned(hr: TestClient, employee: TestClient, fieldId: string) {
    const { applicationId } = await acceptedTrainee(hr, fieldId);
    const { id } = await body<{ id: string }>(
      await employee.post('/api/employee/mentor-requests', { applicationId, note: 'Front end' }),
    );
    const approved = await body<{ assignmentId: string }>(
      await hr.post(`/api/hr/mentor-requests/${id}/approve`, { startDate: '2027-02-01', endDate: '2027-04-30' }),
    );
    return approved.assignmentId;
  }

  it('each employee sees, reads and writes only their own trainees and notes; notes only while active', async () => {
    const { hr, employee, field } = await cast();
    const colleague = await signInStaff(api, 'Employee');
    const mine = await assigned(hr.client, employee.client, field.id);
    const theirs = await assigned(hr.client, colleague.client, field.id);

    const trainees = await body<{ id: string }[]>(await employee.client.get('/api/employee/trainees'));
    expect(trainees.map((t) => t.id)).toEqual([mine]);
    expect((await employee.client.get(`/api/employee/assignments/${theirs}/notes`)).status).toBe(404);
    expect((await employee.client.post(`/api/employee/assignments/${theirs}/notes`, { text: 'Hi' })).status).toBe(404);
    expect((await employee.client.post(`/api/employee/assignments/${mine}/notes`, { text: ' ' })).status).toBe(400);

    // Previous trainees (another status than Active; set directly, as the running-training features are not built yet).
    await withDb((db) => db.query("UPDATE assignments SET status = 'Completed' WHERE id = $1", [mine]));
    const previous = await body<{ id: string; status: string }[]>(await employee.client.get('/api/employee/trainees'));
    expect(previous).toEqual([expect.objectContaining({ id: mine, status: 'Completed' })]);
    const late = await employee.client.post(`/api/employee/assignments/${mine}/notes`, { text: 'After the end' });
    expect(late.status).toBe(400);
    expect((await body(late)).code).toBe('progress_note.not_active');
  });

  it('records are protected: nothing can be deleted', async () => {
    const { hr, employee, field } = await cast();
    const id = await assigned(hr.client, employee.client, field.id);
    for (const table of [
      'assignments',
      'mentor_requests',
      'training_applications',
      'application_attachments',
      'progress_notes',
    ]) {
      await expect(
        withDb((db) => db.query(`DELETE FROM ${table} WHERE false`)),
        table,
      ).resolves.toBeDefined();
    }
    await expect(withDb((db) => db.query('DELETE FROM assignments WHERE id = $1', [id]))).rejects.toThrow(
      /not allowed/,
    );
  });
});

describe('progress notes: current behaviour', () => {
  // These tests pin what is implemented today. Notes only while Active, no editing, and who reads them are
  // implementation choices still open with the owner (decisions.md AD-49, Q37, Q40); the tests do not approve them.
  async function assignedTo(hr: TestClient, employee: TestClient, fieldId: string) {
    const { applicationId } = await acceptedTrainee(hr, fieldId);
    const { id } = await body<{ id: string }>(
      await employee.post('/api/employee/mentor-requests', { applicationId, note: 'Front end' }),
    );
    return (
      await body<{ assignmentId: string }>(
        await hr.post(`/api/hr/mentor-requests/${id}/approve`, { startDate: '2027-02-01', endDate: '2027-04-30' }),
      )
    ).assignmentId;
  }

  async function writeNote(employee: TestClient, assignmentId: string, text: string) {
    const response = await employee.post(`/api/employee/assignments/${assignmentId}/notes`, { text });
    expect(response.status).toBe(201);
    return (await body<{ id: string }>(response)).id;
  }

  const notesOf = (assignmentId: string) =>
    withDb((db) =>
      db.query<{ id: string; text: string }>('SELECT id, text FROM progress_notes WHERE assignment_id = $1', [
        assignmentId,
      ]),
    ).then((r) => r.rows);

  it('the employee still reads the notes of their own assignment once it is no longer Active', async () => {
    const { hr, employee, field } = await cast();
    const assignmentId = await assignedTo(hr.client, employee.client, field.id);
    await writeNote(employee.client, assignmentId, 'Week one done');

    // Set directly: the running-training actions (end, transfer, withdraw) are not built yet.
    await withDb((db) => db.query("UPDATE assignments SET status = 'Completed' WHERE id = $1", [assignmentId]));

    const read = await employee.client.get(`/api/employee/assignments/${assignmentId}/notes`);
    expect(read.status).toBe(200);
    expect((await body<{ text: string; authorName: string }[]>(read)).map((n) => n.text)).toEqual(['Week one done']);
  });

  it('Trainee, HR and Admin get 403 on both notes endpoints, and nothing is written', async () => {
    const { admin, hr, employee, field } = await cast();
    const assignmentId = await assignedTo(hr.client, employee.client, field.id);
    await writeNote(employee.client, assignmentId, 'Only mine');
    const trainee = await signInTrainee(api);

    for (const [role, client] of [
      ['Trainee', trainee.client],
      ['HR', hr.client],
      ['Admin', admin.client],
    ] as const) {
      expect((await client.get(`/api/employee/assignments/${assignmentId}/notes`)).status, role).toBe(403);
      expect(
        (await client.post(`/api/employee/assignments/${assignmentId}/notes`, { text: `By ${role}` })).status,
        role,
      ).toBe(403);
    }
    expect((await notesOf(assignmentId)).map((n) => n.text)).toEqual(['Only mine']);
  });

  it('accepts a note of up to 4000 characters and refuses a longer one', async () => {
    const { hr, employee, field } = await cast();
    const assignmentId = await assignedTo(hr.client, employee.client, field.id);

    await writeNote(employee.client, assignmentId, 'a'.repeat(4000));
    const tooLong = await employee.client.post(`/api/employee/assignments/${assignmentId}/notes`, {
      text: 'a'.repeat(4001),
    });
    expect(tooLong.status).toBe(400);
    expect((await notesOf(assignmentId)).map((n) => n.text.length)).toEqual([4000]);
  });

  it("employees never see each other's notes, even when both have notes", async () => {
    const { hr, employee, field } = await cast();
    const colleague = await signInStaff(api, 'Employee');
    const mine = await assignedTo(hr.client, employee.client, field.id);
    const theirs = await assignedTo(hr.client, colleague.client, field.id);
    await writeNote(employee.client, mine, 'My note');
    await writeNote(colleague.client, theirs, 'Their note');

    const own = await body<{ text: string }[]>(await employee.client.get(`/api/employee/assignments/${mine}/notes`));
    expect(own.map((n) => n.text)).toEqual(['My note']);
    expect((await employee.client.get(`/api/employee/assignments/${theirs}/notes`)).status).toBe(404);
    expect((await colleague.client.get(`/api/employee/assignments/${mine}/notes`)).status).toBe(404);
    expect((await colleague.client.post(`/api/employee/assignments/${mine}/notes`, { text: 'Hi' })).status).toBe(404);
    expect((await notesOf(mine)).map((n) => n.text)).toEqual(['My note']);
  });

  it('a new note is audited by the database with the employee as actor and the saved values', async () => {
    const { hr, employee, field } = await cast();
    const assignmentId = await assignedTo(hr.client, employee.client, field.id);
    const noteId = await writeNote(employee.client, assignmentId, 'Audited note');

    const { rows } = await withDb((db) =>
      db.query<{
        operation: string;
        actor_type: string;
        actor_id: string;
        old_values: unknown;
        new_values: Record<string, unknown>;
      }>(
        "SELECT operation, actor_type, actor_id, old_values, new_values FROM audit_logs WHERE table_name = 'progress_notes' AND entity_id = $1",
        [noteId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'INSERT',
      actor_type: 'Staff',
      actor_id: employee.user.id,
      old_values: null,
    });
    expect(rows[0]!.new_values).toMatchObject({
      assignment_id: assignmentId,
      author_id: employee.user.id,
      text: 'Audited note',
    });
  });

  it('the database refuses DELETE and TRUNCATE of a real note, which stays unchanged', async () => {
    const { hr, employee, field } = await cast();
    const assignmentId = await assignedTo(hr.client, employee.client, field.id);
    const noteId = await writeNote(employee.client, assignmentId, 'Permanent');

    await expect(withDb((db) => db.query('DELETE FROM progress_notes WHERE id = $1', [noteId]))).rejects.toThrow(
      /not allowed/,
    );
    await expect(withDb((db) => db.query('TRUNCATE progress_notes CASCADE'))).rejects.toThrow(/not allowed/);
    expect(await notesOf(assignmentId)).toEqual([{ id: noteId, text: 'Permanent' }]);
    expect((await audit(noteId)).map((a) => a.operation)).toEqual(['INSERT']);
  });

  it('a change made directly in the database is audited (the API offers no editing)', async () => {
    const { hr, employee, field } = await cast();
    const assignmentId = await assignedTo(hr.client, employee.client, field.id);
    const noteId = await writeNote(employee.client, assignmentId, 'Before');

    await withDb((db) => db.query("UPDATE progress_notes SET text = 'After' WHERE id = $1", [noteId]));

    const { rows } = await withDb((db) =>
      db.query<{ actor_type: string; old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
        "SELECT actor_type, old_values, new_values FROM audit_logs WHERE entity_id = $1 AND operation = 'UPDATE'",
        [noteId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_type).toBe('Database');
    expect(rows[0]!.old_values).toMatchObject({ text: 'Before' });
    expect(rows[0]!.new_values).toMatchObject({ text: 'After' });
  });
});

describe('Admin: accepted trainees (PDF §2)', () => {
  type Accepted = {
    applicationId: string;
    trainee: { fullName: string | null; university: string | null };
    fieldName: string;
    availableFrom: string;
    availableTo: string;
    hours: number;
    acceptedAt: string | null;
    assignments: { employeeName: string; status: string; startDate: string; endDate: string }[];
  };

  it('lists only accepted applications, read-only, with their recorded assignments', async () => {
    const { admin, hr, employee, field } = await cast();
    const accepted = await acceptedTrainee(hr.client, field.id, { fullName: 'Accepted One' });
    const assigned = await acceptedTrainee(hr.client, field.id, { fullName: 'Assigned One' });
    const { id: requestId } = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', {
        applicationId: assigned.applicationId,
        note: 'API',
      }),
    );
    await hr.client.post(`/api/hr/mentor-requests/${requestId}/approve`, {
      startDate: '2027-02-01',
      endDate: '2027-04-30',
    });

    const submitted = await signInTrainee(api);
    const pending = await body<{ id: string }>(
      await submitted.client.post(
        '/api/trainee/applications',
        applicationForm(field.id, { fullName: 'Still Submitted' }),
      ),
    );
    const rejectedTrainee = await signInTrainee(api);
    const rejected = await body<{ id: string }>(
      await rejectedTrainee.client.post(
        '/api/trainee/applications',
        applicationForm(field.id, { fullName: 'Rejected One' }),
      ),
    );
    await hr.client.post(`/api/hr/applications/${rejected.id}/reject`, { reason: 'Full' });

    const response = await admin.client.get('/api/admin/accepted-trainees');
    expect(response.status).toBe(200);
    const list = await body<Accepted[]>(response);
    const ids = list.map((a) => a.applicationId);
    expect(ids).toEqual(expect.arrayContaining([accepted.applicationId, assigned.applicationId]));
    expect(ids).not.toContain(pending.id);
    expect(ids).not.toContain(rejected.id);

    // C5 (owner decision 2026-10-31): no e-mail, phone or CV.
    const raw = JSON.stringify(list);
    expect(raw).not.toContain(accepted.email);
    expect(raw).not.toContain('000-0000');
    expect(raw).not.toMatch(/"(email|phone|cv|attachments|hasCv)"/);
    const one = list.find((a) => a.applicationId === accepted.applicationId)!;
    expect(one).toMatchObject({
      trainee: { fullName: 'Accepted One', university: 'Example University' },
      fieldName: field.name,
      availableFrom: '2027-02-01',
      availableTo: '2027-04-30',
      hours: 240,
      assignments: [],
    });
    expect(one.acceptedAt).not.toBeNull();
    expect(list.find((a) => a.applicationId === assigned.applicationId)!.assignments).toEqual([
      { employeeName: expect.any(String), status: 'Active', startDate: '2027-02-01', endDate: '2027-04-30' },
    ]);

    // Read-only: nothing else answers on this path, and nothing was written by reading it.
    expect((await admin.client.post('/api/admin/accepted-trainees', {})).status).toBe(405);
  });

  it('is for the Admin only', async () => {
    const { hr, employee } = await cast();
    const trainee = await signInTrainee(api);
    for (const client of [hr.client, employee.client, trainee.client]) {
      expect((await client.get('/api/admin/accepted-trainees')).status).toBe(403);
    }
    expect((await api.client().get('/api/admin/accepted-trainees')).status).toBe(401);
  });
});

describe('HR: running trainings (read-only)', () => {
  type HrAssignment = {
    id: string;
    applicationId: string;
    status: string;
    startDate: string;
    endDate: string;
    trainee: { id: string; fullName: string | null };
    employee: { id: string; fullName: string };
    fieldName: string;
  };

  async function assign(hr: TestClient, employee: TestClient, fieldId: string, fullName: string) {
    const trainee = await acceptedTrainee(hr, fieldId, { fullName });
    const { id } = await body<{ id: string }>(
      await employee.post('/api/employee/mentor-requests', { applicationId: trainee.applicationId, note: 'Work' }),
    );
    const { assignmentId } = await body<{ assignmentId: string }>(
      await hr.post(`/api/hr/mentor-requests/${id}/approve`, { startDate: '2027-03-01', endDate: '2027-05-31' }),
    );
    return { assignmentId, trainee };
  }

  it('lists every assignment with trainee, mentor, field, dates and the recorded status', async () => {
    const { hr, employee, field } = await cast();
    const colleague = await signInStaff(api, 'Employee');
    const current = await assign(hr.client, employee.client, field.id, 'Current Trainee');
    const previous = await assign(hr.client, colleague.client, field.id, 'Previous Trainee');
    // Set directly: the lifecycle actions are not built; the list only reports what is stored.
    await withDb((db) =>
      db.query("UPDATE assignments SET status = 'Completed' WHERE id = $1", [previous.assignmentId]),
    );

    const before = await withDb((db) =>
      db.query('SELECT id, status, start_date, end_date, xmin::text FROM assignments'),
    );
    const response = await hr.client.get('/api/hr/assignments');
    expect(response.status).toBe(200);
    const list = await body<HrAssignment[]>(response);

    expect(list.find((a) => a.id === current.assignmentId)).toEqual({
      id: current.assignmentId,
      applicationId: current.trainee.applicationId,
      status: 'Active',
      startDate: '2027-03-01',
      endDate: '2027-05-31',
      trainee: { id: current.trainee.user.id, fullName: 'Current Trainee', email: current.trainee.email },
      employee: { id: employee.user.id, fullName: expect.any(String), email: employee.email },
      fieldName: field.name,
    });
    expect(list.find((a) => a.id === previous.assignmentId)).toMatchObject({
      status: 'Completed',
      employee: { id: colleague.user.id },
    });
    // Reading changes nothing.
    expect(
      (await withDb((db) => db.query('SELECT id, status, start_date, end_date, xmin::text FROM assignments'))).rows,
    ).toEqual(before.rows);
  });

  it('is for HR only, and offers no changes', async () => {
    const { admin, hr, employee } = await cast();
    const trainee = await signInTrainee(api);
    for (const client of [admin.client, employee.client, trainee.client]) {
      expect((await client.get('/api/hr/assignments')).status).toBe(403);
    }
    expect((await hr.client.post('/api/hr/assignments', {})).status).toBe(405);
  });
});

describe('HR: trainee history (PDF §6)', () => {
  type History = {
    trainee: { id: string; fullName: string | null; email: string };
    applications: {
      id: string;
      status: string;
      fieldName: string;
      rejectionReason: string | null;
      assignments: {
        id: string;
        employeeName: string;
        status: string;
        startDate: string;
        endDate: string;
        endReason: string | null;
      }[];
      contactLogs: { id: string; contactDate: string; method: string; summary: string; authorName: string }[];
    }[];
  };

  it('shows every application of one trainee with its trainings and contact log, and nothing of others', async () => {
    const { hr, employee, field } = await cast();
    // First application: rejected with a reason, with a contact-log entry.
    const trainee = await signInTrainee(api);
    const first = await body<{ id: string }>(
      await trainee.client.post(
        '/api/trainee/applications',
        applicationForm(field.id, { fullName: 'History Trainee' }),
      ),
    );
    await hr.client.post(`/api/hr/applications/${first.id}/contact-logs`, {
      contactDate: '2026-10-20',
      method: 'Phone',
      summary: 'Period does not fit.',
    });
    await hr.client.post(`/api/hr/applications/${first.id}/reject`, { reason: 'Period is full' });
    // Second application (PDF §4: a trainee may apply again): accepted and assigned.
    const second = await body<{ id: string }>(
      await trainee.client.post('/api/trainee/applications', applicationForm(field.id)),
    );
    await hr.client.post(`/api/hr/applications/${second.id}/accept`);
    const { id: requestId } = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', { applicationId: second.id, note: 'Testing' }),
    );
    const { assignmentId } = await body<{ assignmentId: string }>(
      await hr.client.post(`/api/hr/mentor-requests/${requestId}/approve`, {
        startDate: '2027-02-01',
        endDate: '2027-04-30',
      }),
    );
    // Someone else's records must not appear.
    const other = await acceptedTrainee(hr.client, field.id, { fullName: 'Other Trainee' });
    await hr.client.post(`/api/hr/applications/${other.applicationId}/contact-logs`, {
      contactDate: '2026-10-21',
      method: 'Email',
      summary: 'Not this trainee.',
    });

    const before = await withDb((db) =>
      db.query(
        "SELECT 'a' AS t, id, xmin::text FROM assignments UNION ALL SELECT 'c', id, xmin::text FROM contact_logs ORDER BY 2",
      ),
    );
    const response = await hr.client.get(`/api/hr/trainees/${trainee.user.id}/history`);
    expect(response.status).toBe(200);
    const history = await body<History>(response);

    expect(history.trainee).toMatchObject({ id: trainee.user.id, fullName: 'History Trainee', email: trainee.email });
    expect(history.applications.map((a) => [a.id, a.status])).toEqual([
      [first.id, 'Rejected'],
      [second.id, 'Accepted'],
    ]);
    const [rejected, accepted] = history.applications;
    expect(rejected!.rejectionReason).toBe('Period is full');
    expect(rejected!.assignments).toEqual([]);
    expect(rejected!.contactLogs).toEqual([
      expect.objectContaining({ contactDate: '2026-10-20', method: 'Phone', summary: 'Period does not fit.' }),
    ]);
    expect(accepted!.assignments).toEqual([
      {
        id: assignmentId,
        employeeName: expect.any(String),
        status: 'Active',
        startDate: '2027-02-01',
        endDate: '2027-04-30',
        endReason: null,
      },
    ]);
    expect(accepted!.contactLogs).toEqual([]);
    expect(JSON.stringify(history)).not.toContain('Not this trainee.');
    expect(JSON.stringify(history)).not.toContain(other.applicationId);

    // Reading changes nothing.
    expect(
      (
        await withDb((db) =>
          db.query(
            "SELECT 'a' AS t, id, xmin::text FROM assignments UNION ALL SELECT 'c', id, xmin::text FROM contact_logs ORDER BY 2",
          ),
        )
      ).rows,
    ).toEqual(before.rows);

    // The trainee list leads to the history. This trainee has a Rejected and an Accepted application: listed once,
    // and the rejected application's contact note above is still part of the report.
    const trainees = await body<{ id: string; applications: number }[]>(await hr.client.get('/api/hr/trainees'));
    expect(trainees.filter((t) => t.id === trainee.user.id)).toEqual([expect.objectContaining({ applications: 2 })]);
  });

  it('only trainees with at least one Accepted application are in the report, in the list and by direct request', async () => {
    const { hr, field } = await cast();
    const apply = async (fullName: string) => {
      const trainee = await signInTrainee(api);
      const application = await body<{ id: string }>(
        await trainee.client.post('/api/trainee/applications', applicationForm(field.id, { fullName })),
      );
      return { ...trainee, applicationId: application.id };
    };
    const submitted = await apply('Only Submitted');
    const underReview = await apply('Only Under Review');
    await hr.client.post(`/api/hr/applications/${underReview.applicationId}/review`);
    const rejected = await apply('Only Rejected');
    await hr.client.post(`/api/hr/applications/${rejected.applicationId}/reject`, { reason: 'Full' });
    // Two applications, the second accepted: eligible once.
    const twice = await apply('Accepted Second Time');
    await hr.client.post(`/api/hr/applications/${twice.applicationId}/reject`, { reason: 'Full' });
    const second = await body<{ id: string }>(
      await twice.client.post('/api/trainee/applications', applicationForm(field.id)),
    );
    await hr.client.post(`/api/hr/applications/${second.id}/accept`);

    const statuses = await withDb((db) => db.query('SELECT id, status FROM training_applications ORDER BY id'));
    const list = await body<{ id: string }[]>(await hr.client.get('/api/hr/trainees'));
    const ids = list.map((t) => t.id);
    expect(ids.filter((id) => id === twice.user.id)).toHaveLength(1);
    for (const ineligible of [submitted, underReview, rejected]) {
      expect(ids).not.toContain(ineligible.user.id);
      // Direct navigation cannot bypass the rule.
      expect((await hr.client.get(`/api/hr/trainees/${ineligible.user.id}/history`)).status).toBe(404);
    }
    const history = await body<{ applications: { id: string; status: string }[] }>(
      await hr.client.get(`/api/hr/trainees/${twice.user.id}/history`),
    );
    expect(history.applications.map((a) => a.status)).toEqual(['Rejected', 'Accepted']); // nothing hidden
    // Reading changes no status.
    expect((await withDb((db) => db.query('SELECT id, status FROM training_applications ORDER BY id'))).rows).toEqual(
      statuses.rows,
    );
  });

  it('answers 404 for an unknown trainee, and is for HR only', async () => {
    const { admin, hr, employee } = await cast();
    const trainee = await signInTrainee(api);
    expect((await hr.client.get(`/api/hr/trainees/${crypto.randomUUID()}/history`)).status).toBe(404);
    for (const client of [admin.client, employee.client, trainee.client]) {
      expect((await client.get('/api/hr/trainees')).status).toBe(403);
      expect((await client.get(`/api/hr/trainees/${trainee.user.id}/history`)).status).toBe(403);
    }
  });
});

describe('in-app notifications (PDF §7, events whose workflow exists)', () => {
  type Inbox = {
    unreadCount: number;
    hasMore: boolean;
    notifications: {
      id: string;
      type: string;
      isRead: boolean;
      createdAt: string;
      applicationId: string | null;
      traineeName: string | null;
      fieldName: string | null;
      employeeName: string | null;
    }[];
  };
  const inbox = async (client: TestClient) => body<Inbox>(await client.get('/api/notifications'));
  const about = (box: Inbox, type: string, applicationId: string) =>
    box.notifications.filter((n) => n.type === type && n.applicationId === applicationId);

  it('a new application notifies every HR member, and nobody else', async () => {
    const { admin, hr, employee, field } = await cast();
    const hr2 = await signInStaff(api, 'HR');
    const { applicationId } = await acceptedTrainee(hr.client, field.id, { fullName: 'Notified Trainee' });

    for (const member of [hr, hr2]) {
      const box = await inbox(member.client);
      expect(about(box, 'ApplicationSubmitted', applicationId)).toEqual([
        expect.objectContaining({
          isRead: false,
          traineeName: 'Notified Trainee',
          fieldName: field.name,
          employeeName: null,
        }),
      ]);
    }
    expect(about(await inbox(employee.client), 'ApplicationSubmitted', applicationId)).toEqual([]);
    expect((await admin.client.get('/api/notifications')).status).toBe(403);
  });

  it('a mentor request notifies HR; the decision notifies only the employee who asked', async () => {
    const { hr, employee, field } = await cast();
    const colleague = await signInStaff(api, 'Employee');
    const approvedFor = await acceptedTrainee(hr.client, field.id, { fullName: 'Approved Trainee' });
    const rejectedFor = await acceptedTrainee(hr.client, field.id, { fullName: 'Rejected Trainee' });
    const ask = async (client: TestClient, applicationId: string) =>
      (
        await body<{ id: string }>(
          await client.post('/api/employee/mentor-requests', { applicationId, note: 'Mentoring' }),
        )
      ).id;
    const approved = await ask(employee.client, approvedFor.applicationId);
    const rejected = await ask(employee.client, rejectedFor.applicationId);

    const hrBox = await inbox(hr.client);
    expect(about(hrBox, 'MentorRequestSubmitted', approvedFor.applicationId)).toEqual([
      expect.objectContaining({ traineeName: 'Approved Trainee', employeeName: expect.any(String) }),
    ]);
    expect(about(hrBox, 'MentorRequestSubmitted', rejectedFor.applicationId)).toHaveLength(1);

    expect(
      (
        await hr.client.post(`/api/hr/mentor-requests/${approved}/approve`, {
          startDate: '2027-02-01',
          endDate: '2027-04-30',
        })
      ).status,
    ).toBe(200);
    expect((await hr.client.post(`/api/hr/mentor-requests/${rejected}/reject`)).status).toBe(200);

    const box = await inbox(employee.client);
    expect(about(box, 'MentorRequestApproved', approvedFor.applicationId)).toEqual([
      expect.objectContaining({ isRead: false, traineeName: 'Approved Trainee', fieldName: field.name }),
    ]);
    expect(about(box, 'MentorRequestRejected', rejectedFor.applicationId)).toHaveLength(1);
    const colleagueBox = await inbox(colleague.client);
    expect(
      colleagueBox.notifications.filter((n) =>
        [approvedFor.applicationId, rejectedFor.applicationId].includes(n.applicationId!),
      ),
    ).toEqual([]);
    // HR is not told about its own decisions; employees are not told about HR's events.
    expect(about(await inbox(hr.client), 'MentorRequestApproved', approvedFor.applicationId)).toEqual([]);
    expect(about(box, 'MentorRequestSubmitted', approvedFor.applicationId)).toEqual([]);
  });

  it('a retried action or a repeated write adds no duplicate', async () => {
    const { hr, employee, field } = await cast();
    const trainee = await acceptedTrainee(hr.client, field.id);
    const { id } = await body<{ id: string }>(
      await employee.client.post('/api/employee/mentor-requests', {
        applicationId: trainee.applicationId,
        note: 'Once',
      }),
    );
    const approve = () =>
      hr.client.post(`/api/hr/mentor-requests/${id}/approve`, { startDate: '2027-02-01', endDate: '2027-04-30' });
    expect((await approve()).status).toBe(200);
    expect((await approve()).status).not.toBe(200); // the request is no longer pending
    const count = () =>
      withDb((db) =>
        db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM notifications WHERE entity_id = $1 AND recipient_id = $2',
          [id, employee.user.id],
        ),
      ).then((r) => r.rows[0]!.n);
    expect(await count()).toBe(1);

    // The same event written again (as a retried transaction would) is ignored by the unique index.
    await withDb((db) =>
      db.query(
        `INSERT INTO notifications (id, recipient_id, type, entity_id, is_read, created_at)
         VALUES ($1, $2, 'MentorRequestApproved', $3, false, now()) ON CONFLICT (recipient_id, type, entity_id) DO NOTHING`,
        [crypto.randomUUID(), employee.user.id, id],
      ),
    );
    expect(await count()).toBe(1);
    await expect(
      withDb((db) =>
        db.query(
          `INSERT INTO notifications (id, recipient_id, type, entity_id, is_read, created_at)
           VALUES ($1, $2, 'MentorRequestApproved', $3, false, now())`,
          [crypto.randomUUID(), employee.user.id, id],
        ),
      ),
    ).rejects.toThrow(/ux_notifications_recipient_id_type_entity_id/);
  });

  it('marks only your own notification read, once, audited; other users get 404', async () => {
    const { hr, field } = await cast();
    const otherHr = await signInStaff(api, 'HR');
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const mine = about(await inbox(hr.client), 'ApplicationSubmitted', applicationId)[0]!;
    const before = (await inbox(hr.client)).unreadCount;

    expect((await otherHr.client.post(`/api/notifications/${mine.id}/read`)).status).toBe(404);
    expect((await hr.client.post(`/api/notifications/${mine.id}/read`)).status).toBe(204);
    expect((await hr.client.post(`/api/notifications/${mine.id}/read`)).status).toBe(204); // already read: no change
    expect((await hr.client.post(`/api/notifications/${crypto.randomUUID()}/read`)).status).toBe(404);

    const after = await inbox(hr.client);
    expect(after.unreadCount).toBe(before - 1);
    expect(after.notifications.find((n) => n.id === mine.id)!.isRead).toBe(true);
    // The other HR member's copy is still unread.
    expect(about(await inbox(otherHr.client), 'ApplicationSubmitted', applicationId)[0]!.isRead).toBe(false);
    expect((await audit(mine.id)).map((a) => [a.operation, a.actor_type, a.actor_id])).toEqual([
      ['INSERT', 'Trainee', expect.any(String)],
      ['UPDATE', 'Staff', hr.user.id],
    ]);
  });

  it('pages through every notification newest first, without gaps or repeats, with an accurate unread count', async () => {
    const employee = await signInStaff(api, 'Employee');
    // 45 notifications for this employee, written directly (the events themselves are tested above). Some share a
    // timestamp, so the id must break ties; ids are random, so their order is independent of the time order.
    const base = Date.parse('2026-10-31T08:00:00Z');
    const written: { id: string; at: Date }[] = [];
    await withDb(async (db) => {
      for (let i = 0; i < 45; i++) {
        const id = crypto.randomUUID();
        const at = new Date(base + Math.floor(i / 3) * 60_000); // three per minute
        written.push({ id, at });
        await db.query(
          `INSERT INTO notifications (id, recipient_id, type, entity_id, is_read, created_at)
           VALUES ($1, $2, $3, $4, false, $5)`,
          [id, employee.user.id, i % 2 ? 'MentorRequestApproved' : 'MentorRequestRejected', crypto.randomUUID(), at],
        );
      }
    });
    const expected = [...written]
      .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((n) => n.id);

    const pages: Inbox[] = [];
    let before: string | null = null;
    do {
      const response = await employee.client.get(`/api/notifications${before ? `?before=${before}` : ''}`);
      expect(response.status).toBe(200);
      const page = await body<Inbox>(response);
      pages.push(page);
      before = page.hasMore ? page.notifications.at(-1)!.id : null;
    } while (before);

    expect(pages.map((p) => p.notifications.length)).toEqual([20, 20, 5]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(pages.flatMap((p) => p.notifications.map((n) => n.id))).toEqual(expected); // all, in order, once each
    expect(pages.every((p) => p.unreadCount === 45)).toBe(true);

    // A new notification arriving between pages does not shift older pages.
    const second = await body<Inbox>(
      await employee.client.get(`/api/notifications?before=${pages[0]!.notifications.at(-1)!.id}`),
    );
    await withDb((db) =>
      db.query(
        `INSERT INTO notifications (id, recipient_id, type, entity_id, is_read, created_at)
         VALUES ($1, $2, 'MentorRequestApproved', $3, false, now())`,
        [crypto.randomUUID(), employee.user.id, crypto.randomUUID()],
      ),
    );
    expect(
      (await body<Inbox>(await employee.client.get(`/api/notifications?before=${pages[0]!.notifications.at(-1)!.id}`)))
        .notifications,
    ).toEqual(second.notifications);

    // The oldest unread one (only on the last page) can be marked read, and the count follows.
    const oldest = expected.at(-1)!;
    expect((await employee.client.post(`/api/notifications/${oldest}/read`)).status).toBe(204);
    const first = await body<Inbox>(await employee.client.get('/api/notifications'));
    expect(first.unreadCount).toBe(45); // 46 written, one read
    const last = await body<Inbox>(await employee.client.get(`/api/notifications?before=${expected.at(-2)}`));
    expect(last.notifications).toEqual([expect.objectContaining({ id: oldest, isRead: true })]);
    expect(last.hasMore).toBe(false);
  });

  it('refuses a page position that is malformed or not one of your own notifications', async () => {
    const { hr, employee, field } = await cast();
    await acceptedTrainee(hr.client, field.id);
    const hrNote = (await inbox(hr.client)).notifications[0]!;
    expect((await employee.client.get(`/api/notifications?before=${hrNote.id}`)).status).toBe(400);
    expect((await hr.client.get('/api/notifications?before=not-an-id')).status).toBe(400);
    expect((await hr.client.get(`/api/notifications?before=${crypto.randomUUID()}`)).status).toBe(400);
    expect((await hr.client.get(`/api/notifications?before=${hrNote.id}`)).status).toBe(200);
  });

  it("after a role change the previous role's notifications are hidden but kept, and return with the role (C2)", async () => {
    const { hr, field } = await cast();
    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const note = about(await inbox(hr.client), 'ApplicationSubmitted', applicationId)[0]!;
    const unreadAsHr = (await inbox(hr.client)).unreadCount;

    await setRole(hr.email, 'Employee');
    const asEmployee = await inbox(hr.client);
    expect(asEmployee.notifications.find((n) => n.id === note.id)).toBeUndefined();
    expect(asEmployee.unreadCount).toBe(0); // HR's unread notifications are not counted for the Employee role
    expect((await hr.client.post(`/api/notifications/${note.id}/read`)).status).toBe(404);
    expect((await hr.client.get(`/api/notifications?before=${note.id}`)).status).toBe(400);
    const kept = await withDb((db) => db.query('SELECT is_read FROM notifications WHERE id = $1', [note.id]));
    expect(kept.rows).toEqual([{ is_read: false }]); // still in the database, unchanged

    await setRole(hr.email, 'HR');
    const back = await inbox(hr.client);
    expect(back.notifications.find((n) => n.id === note.id)).toMatchObject({ isRead: false });
    expect(back.unreadCount).toBe(unreadAsHr);
  });

  it('each role sees only its own notification types; Trainee and Admin have none; deleting is refused', async () => {
    const { admin, hr, field } = await cast();
    const trainee = await signInTrainee(api);
    for (const client of [trainee.client, admin.client]) {
      expect((await client.get('/api/notifications')).status).toBe(403);
      expect((await client.post(`/api/notifications/${crypto.randomUUID()}/read`)).status).toBe(403);
    }
    expect((await api.client().get('/api/notifications')).status).toBe(401);

    const { applicationId } = await acceptedTrainee(hr.client, field.id);
    const note = about(await inbox(hr.client), 'ApplicationSubmitted', applicationId)[0]!;
    // An HR member who becomes an Employee no longer sees HR's notifications, nor can mark them.
    await setRole(hr.email, 'Employee');
    expect(about(await inbox(hr.client), 'ApplicationSubmitted', applicationId)).toEqual([]);
    expect((await hr.client.post(`/api/notifications/${note.id}/read`)).status).toBe(404);

    await expect(withDb((db) => db.query('DELETE FROM notifications WHERE id = $1', [note.id]))).rejects.toThrow(
      /not allowed/,
    );
    await expect(withDb((db) => db.query('TRUNCATE notifications CASCADE'))).rejects.toThrow(/not allowed/);
  });
});

// The FILES binding comes from wrangler.jsonc (simulated locally).
void (env as unknown as Bindings).FILES;
