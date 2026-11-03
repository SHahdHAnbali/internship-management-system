import { describe, expect, it } from 'vitest';
import { monthBounds } from '../src/features/reports/monthlyReport';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, unique, withDb } from './helpers';

/**
 * The monthly report (PDF §6 «التقرير الشهري»): every assignment whose recorded period overlaps the month, with the
 * trainee, the employee, the field and the dates, for HR and the Admin. Applications are accepted through the real
 * endpoints; assignments are seeded directly (actor System) because the lifecycle actions that would give them other
 * statuses and dates (end early, transfer, withdraw) are not built. The report only reads what is stored.
 */
const api = createTestApi();

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // "%PDF-1.7\n"

interface Report {
  month: string;
  monthStart: string;
  monthEnd: string;
  rows: {
    assignmentId: string;
    traineeName: string | null;
    employee: { id: string; fullName: string };
    field: { id: string; name: string };
    startDate: string;
    endDate: string;
  }[];
}

async function newField(admin: TestClient) {
  return body<{ id: string; name: string }>(
    await admin.post('/api/admin/fields', { name: unique('Field'), description: null }),
  );
}

/** A trainee whose application (in `fieldId`) HR accepted through the real endpoints. */
async function acceptedApplication(hr: TestClient, fieldId: string, fullName: string) {
  const trainee = await signInTrainee(api);
  const form = new FormData();
  const values: Record<string, string> = {
    fullName,
    phone: '000-0000',
    university: 'Example University',
    major: 'Computer Engineering',
    studyYear: 'Fourth year',
    fieldId,
    availableFrom: '2031-01-01',
    availableTo: '2031-06-30',
    hours: '240',
    mandatoryForUniversity: 'true',
  };
  for (const [name, value] of Object.entries(values)) form.append(name, value);
  form.append('cv', new File([PDF], 'cv.pdf', { type: 'application/pdf' }));
  const submitted = await trainee.client.post('/api/trainee/applications', form);
  expect(submitted.status).toBe(201);
  const { id } = await body<{ id: string }>(submitted);
  expect((await hr.post(`/api/hr/applications/${id}/accept`)).status).toBe(200);
  return id;
}

/** An assignment as stored, with the given dates and status. */
async function seedAssignment(applicationId: string, employeeId: string, start: string, end: string, status: string) {
  const id = crypto.randomUUID();
  await withDb(async (db) => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('ims.actor_type', 'System', true)");
    await db.query(
      `INSERT INTO assignments (id, application_id, employee_id, mentor_request_id, start_date, end_date, status,
                                end_reason, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, NULL, now())`,
      [id, applicationId, employeeId, start, end, status],
    );
    await db.query('COMMIT');
  });
  return id;
}

async function cast() {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const employee = await signInStaff(api, 'Employee');
  const colleague = await signInStaff(api, 'Employee');
  const field = await newField(admin.client);
  const otherField = await newField(admin.client);
  return { admin, hr, employee, colleague, field, otherField };
}

const report = async (client: TestClient, query: string) => {
  const response = await client.get(`/api/hr/reports/monthly?${query}`);
  expect(response.status).toBe(200);
  return body<Report>(response);
};
const ids = (r: Report) => r.rows.map((row) => row.assignmentId);

describe('month boundaries', () => {
  it('gives the first and last calendar day of the month', () => {
    expect(monthBounds('2031-02')).toEqual({ start: '2031-02-01', end: '2031-02-28' });
    expect(monthBounds('2032-02')).toEqual({ start: '2032-02-01', end: '2032-02-29' }); // leap year
    expect(monthBounds('2031-04')).toEqual({ start: '2031-04-01', end: '2031-04-30' });
    expect(monthBounds('2031-12')).toEqual({ start: '2031-12-01', end: '2031-12-31' });
  });

  it.each([undefined, '', '2031', '2031-13', '2031-00', '2031-2', '31-02', '0999-01', '2031-02-01', 'x'])(
    'rejects %j',
    (value) => expect(monthBounds(value)).toBeNull(),
  );
});

describe('monthly report (PDF §6)', () => {
  it('lists every assignment whose recorded period overlaps the month, inclusive dates, whatever its status', async () => {
    const { hr, employee, field } = await cast();
    // One accepted application per case keeps at most one Active assignment per application (database rule).
    const seed = async (name: string, start: string, end: string, status: string) =>
      seedAssignment(await acceptedApplication(hr.client, field.id, name), employee.user.id, start, end, status);

    const within = await seed('Within', '2031-02-05', '2031-02-20', 'Active');
    const startsBefore = await seed('Starts before', '2031-01-10', '2031-02-10', 'Completed');
    const endsAfter = await seed('Ends after', '2031-02-15', '2031-03-15', 'EndedEarly');
    const covers = await seed('Covers', '2031-01-01', '2031-04-30', 'Transferred');
    const endsOnFirst = await seed('Ends on the 1st', '2031-01-20', '2031-02-01', 'Withdrawn');
    const startsOnLast = await seed('Starts on the 28th', '2031-02-28', '2031-03-31', 'Active');
    const endsTheDayBefore = await seed('Ends on 31 Jan', '2031-01-01', '2031-01-31', 'Completed');
    const startsTheDayAfter = await seed('Starts on 1 Mar', '2031-03-01', '2031-03-31', 'Active');
    const yearBefore = await seed('A year before', '2030-02-01', '2030-02-28', 'Completed');

    const february = await report(hr.client, `month=2031-02&fieldId=${field.id}`);
    expect(february).toMatchObject({ month: '2031-02', monthStart: '2031-02-01', monthEnd: '2031-02-28' });
    // Ordered by start date.
    expect(ids(february)).toEqual([covers, startsBefore, endsOnFirst, within, endsAfter, startsOnLast]);
    for (const outside of [endsTheDayBefore, startsTheDayAfter, yearBefore]) {
      expect(ids(february)).not.toContain(outside);
    }

    // Exactly the documented columns, dates as recorded (no time zone shift).
    expect(february.rows.find((r) => r.assignmentId === within)).toEqual({
      assignmentId: within,
      traineeName: 'Within',
      employee: { id: employee.user.id, fullName: expect.any(String) },
      field: { id: field.id, name: field.name },
      startDate: '2031-02-05',
      endDate: '2031-02-20',
    });

    // The same assignments appear in every other month they overlap.
    expect(ids(await report(hr.client, `month=2031-01&fieldId=${field.id}`))).toEqual([
      covers,
      endsTheDayBefore,
      startsBefore,
      endsOnFirst,
    ]);
    expect(ids(await report(hr.client, `month=2031-03&fieldId=${field.id}`))).toEqual([
      covers,
      endsAfter,
      startsOnLast,
      startsTheDayAfter,
    ]);
  });

  it('filters by field, by employee, and by both', async () => {
    const { hr, employee, colleague, field, otherField } = await cast();
    const mine = await seedAssignment(
      await acceptedApplication(hr.client, field.id, 'Mine'),
      employee.user.id,
      '2031-05-01',
      '2031-05-31',
      'Active',
    );
    const colleagues = await seedAssignment(
      await acceptedApplication(hr.client, field.id, 'Colleague'),
      colleague.user.id,
      '2031-05-10',
      '2031-06-10',
      'Active',
    );
    const otherFieldMine = await seedAssignment(
      await acceptedApplication(hr.client, otherField.id, 'Other field'),
      employee.user.id,
      '2031-04-20',
      '2031-05-05',
      'Active',
    );

    expect(ids(await report(hr.client, `month=2031-05&fieldId=${field.id}`))).toEqual([mine, colleagues]);
    expect(ids(await report(hr.client, `month=2031-05&employeeId=${employee.user.id}`))).toEqual([
      otherFieldMine,
      mine,
    ]);
    expect(ids(await report(hr.client, `month=2031-05&fieldId=${field.id}&employeeId=${employee.user.id}`))).toEqual([
      mine,
    ]);
    expect(
      ids(await report(hr.client, `month=2031-05&fieldId=${otherField.id}&employeeId=${colleague.user.id}`)),
    ).toEqual([]);
    // Without filters, every match is there (other tests' rows too).
    expect(ids(await report(hr.client, 'month=2031-05'))).toEqual(
      expect.arrayContaining([mine, colleagues, otherFieldMine]),
    );
    // Empty filter values mean "all".
    expect(ids(await report(hr.client, `month=2031-05&fieldId=&employeeId=${employee.user.id}`))).toEqual([
      otherFieldMine,
      mine,
    ]);

    // The filter choices are the fields and employees found in assignments.
    const filters = await body<{ fields: { id: string; name: string }[]; employees: { id: string }[] }>(
      await hr.client.get('/api/hr/reports/monthly/filters'),
    );
    expect(filters.fields).toEqual(
      expect.arrayContaining([
        { id: field.id, name: field.name },
        { id: otherField.id, name: otherField.name },
      ]),
    );
    expect(filters.employees.map((e) => e.id)).toEqual(expect.arrayContaining([employee.user.id, colleague.user.id]));
    expect(filters.employees.map((e) => e.id)).not.toContain(hr.user.id); // no assignment, not a choice
  });

  it('shows a trainee moved between employees as two rows, one per recorded assignment', async () => {
    const { hr, employee, colleague, field } = await cast();
    const applicationId = await acceptedApplication(hr.client, field.id, 'Moved Trainee');
    const first = await seedAssignment(applicationId, employee.user.id, '2031-07-01', '2031-07-14', 'Transferred');
    const second = await seedAssignment(applicationId, colleague.user.id, '2031-07-15', '2031-09-30', 'Active');

    const july = await report(hr.client, `month=2031-07&fieldId=${field.id}`);
    expect(july.rows.map((r) => [r.assignmentId, r.traineeName, r.employee.id, r.startDate, r.endDate])).toEqual([
      [first, 'Moved Trainee', employee.user.id, '2031-07-01', '2031-07-14'],
      [second, 'Moved Trainee', colleague.user.id, '2031-07-15', '2031-09-30'],
    ]);
    expect(ids(await report(hr.client, `month=2031-08&fieldId=${field.id}`))).toEqual([second]);
  });

  it('returns an empty list when nothing matches', async () => {
    const { hr, field } = await cast();
    const empty = await report(hr.client, `month=1999-01&fieldId=${field.id}`);
    expect(empty).toEqual({ month: '1999-01', monthStart: '1999-01-01', monthEnd: '1999-01-31', rows: [] });
  });

  it('rejects a missing or malformed month and malformed filters', async () => {
    const { hr } = await cast();
    for (const query of [
      '',
      'month=2031-13',
      'month=2031-2',
      'month=2031-02&fieldId=x',
      'month=2031-02&employeeId=1',
    ]) {
      const response = await hr.client.get(`/api/hr/reports/monthly?${query}`);
      expect(response.status, query).toBe(400);
    }
  });

  it('changes nothing when read', async () => {
    const { hr, admin, employee, field } = await cast();
    const applicationId = await acceptedApplication(hr.client, field.id, 'Read Only');
    const assignmentId = await seedAssignment(applicationId, employee.user.id, '2031-10-01', '2031-10-31', 'Active');
    const snapshot = () =>
      withDb(async (db) => ({
        assignment: (await db.query('SELECT *, xmin::text FROM assignments WHERE id = $1', [assignmentId])).rows,
        application: (await db.query('SELECT *, xmin::text FROM training_applications WHERE id = $1', [applicationId]))
          .rows,
        audit: (
          await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ANY($1)', [
            [assignmentId, applicationId],
          ])
        ).rows,
      }));

    const before = await snapshot();
    await report(hr.client, `month=2031-10&fieldId=${field.id}`);
    await hr.client.get('/api/hr/reports/monthly/filters');
    expect((await admin.client.get(`/api/admin/reports/monthly?month=2031-10&fieldId=${field.id}`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);

    // Read-only endpoints: no other methods.
    for (const path of ['/api/hr/reports/monthly', '/api/admin/reports/monthly']) {
      expect((await hr.client.post(path, {})).status).toBe(405);
    }
  });
});

describe('monthly report: who may read it', () => {
  it('is for HR and the Admin, each in their own area; employees, trainees and anonymous callers are refused', async () => {
    const { admin, hr, employee, field } = await cast();
    const assignmentId = await seedAssignment(
      await acceptedApplication(hr.client, field.id, 'Access Trainee'),
      employee.user.id,
      '2031-11-01',
      '2031-11-30',
      'Active',
    );
    const query = `month=2031-11&fieldId=${field.id}`;

    const asAdmin = await body<Report>(await admin.client.get(`/api/admin/reports/monthly?${query}`));
    const asHr = await body<Report>(await hr.client.get(`/api/hr/reports/monthly?${query}`));
    expect(ids(asAdmin)).toEqual([assignmentId]);
    expect(asAdmin).toEqual(asHr); // the same report
    expect((await admin.client.get('/api/admin/reports/monthly/filters')).status).toBe(200);

    // Nothing beyond the documented columns: no e-mail, phone or CV.
    const text = JSON.stringify(asAdmin);
    for (const hidden of ['@', '000-0000', 'cv.pdf', 'Example University']) expect(text).not.toContain(hidden);

    // Each area's route is for its own role only.
    expect((await admin.client.get(`/api/hr/reports/monthly?${query}`)).status).toBe(403);
    expect((await hr.client.get(`/api/admin/reports/monthly?${query}`)).status).toBe(403);
    expect((await admin.client.get('/api/hr/reports/monthly/filters')).status).toBe(403);
    expect((await hr.client.get('/api/admin/reports/monthly/filters')).status).toBe(403);

    const trainee = await signInTrainee(api);
    for (const client of [employee.client, trainee.client]) {
      for (const path of [
        `/api/hr/reports/monthly?${query}`,
        `/api/admin/reports/monthly?${query}`,
        '/api/hr/reports/monthly/filters',
        '/api/admin/reports/monthly/filters',
      ]) {
        expect((await client.get(path)).status, path).toBe(403);
      }
    }

    const anonymous = api.client();
    for (const path of [
      `/api/hr/reports/monthly?${query}`,
      `/api/admin/reports/monthly?${query}`,
      '/api/hr/reports/monthly/filters',
      '/api/admin/reports/monthly/filters',
    ]) {
      expect((await anonymous.get(path)).status, path).toBe(401);
    }
  });
});
