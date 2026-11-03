import { describe, expect, it } from 'vitest';
import { body, createTestApi, setRole, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * The mentor profile (PDF §6 «ملف المدرّب»), the part that is defined: per employee, the number of trainees they have had
 * (distinct) and of assignment records, over every stored status. HR sees every employee; an employee only themself.
 */
const api = createTestApi();

interface Mentor {
  employee: { id: string; fullName: string };
  trainees: number;
  assignments: number;
}

const allMentors = async (hr: TestClient) => {
  const response = await hr.get('/api/hr/reports/mentor-profile');
  expect(response.status).toBe(200);
  return (await body<{ rows: Mentor[] }>(response)).rows;
};
const ownProfile = async (employee: TestClient, query = '') => {
  const response = await employee.get(`/api/employee/reports/mentor-profile${query}`);
  expect(response.status).toBe(200);
  return body<Mentor>(response);
};

async function cast() {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const field = await newField(admin.client);
  return { admin, hr, field };
}

/** An accepted application of a (new or given) trainee. */
async function accepted(hr: TestClient, fieldId: string, trainee?: Awaited<ReturnType<typeof signInTrainee>>) {
  const who = trainee ?? (await signInTrainee(api));
  const id = await submitApplication(who.client, fieldId);
  expect((await hr.post(`/api/hr/applications/${id}/accept`)).status).toBe(200);
  return { trainee: who, applicationId: id };
}

describe('mentor profile (PDF §6)', () => {
  it('counts each employee’s trainees and assignments, over every stored status', async () => {
    const { hr, field } = await cast();
    const none = await signInStaff(api, 'Employee');
    const one = await signInStaff(api, 'Employee');
    const many = await signInStaff(api, 'Employee');
    const receiving = await signInStaff(api, 'Employee');

    // One assignment.
    await seedAssignment(
      (await accepted(hr.client, field.id)).applicationId,
      one.user.id,
      '2031-01-01',
      '2031-03-31',
      'Active',
    );

    // Several, every status, and the same trainee twice (two applications, both with this employee).
    const lina = await signInTrainee(api);
    const linaFirst = await accepted(hr.client, field.id, lina);
    const linaAgain = await accepted(hr.client, field.id, lina);
    await seedAssignment(linaFirst.applicationId, many.user.id, '2030-01-01', '2030-03-31', 'Completed');
    await seedAssignment(linaAgain.applicationId, many.user.id, '2031-01-01', '2031-03-31', 'Active');
    await seedAssignment(
      (await accepted(hr.client, field.id)).applicationId,
      many.user.id,
      '2031-01-01',
      '2031-01-31',
      'EndedEarly',
    );
    await seedAssignment(
      (await accepted(hr.client, field.id)).applicationId,
      many.user.id,
      '2031-02-01',
      '2031-02-28',
      'Withdrawn',
    );

    // A trainee moved from `many` to `receiving`: one record each, the trainee counted for both.
    const moved = await accepted(hr.client, field.id);
    await seedAssignment(moved.applicationId, many.user.id, '2031-04-01', '2031-04-15', 'Transferred');
    await seedAssignment(moved.applicationId, receiving.user.id, '2031-04-16', '2031-06-30', 'Active');

    const statuses = await withDb((db) =>
      db.query<{ status: string }>('SELECT DISTINCT status FROM assignments WHERE employee_id = $1 ORDER BY status', [
        many.user.id,
      ]),
    );
    expect(statuses.rows.map((r) => r.status)).toEqual([
      'Active',
      'Completed',
      'EndedEarly',
      'Transferred',
      'Withdrawn',
    ]);

    const rows = await allMentors(hr.client);
    const row = (id: string) => rows.find((r) => r.employee.id === id);
    expect(row(none.user.id)).toEqual({
      employee: { id: none.user.id, fullName: expect.any(String) },
      trainees: 0,
      assignments: 0,
    });
    expect(row(one.user.id)).toMatchObject({ trainees: 1, assignments: 1 });
    expect(row(many.user.id)).toMatchObject({ trainees: 4, assignments: 5 }); // Lina twice: one trainee, two records
    expect(row(receiving.user.id)).toMatchObject({ trainees: 1, assignments: 1 });
    // Exactly these fields: no e-mail, department or evaluation.
    expect(Object.keys(row(many.user.id)!).sort()).toEqual(['assignments', 'employee', 'trainees']);
    expect(Object.keys(row(many.user.id)!.employee).sort()).toEqual(['fullName', 'id']);

    // Each employee sees the same numbers for themself.
    expect(await ownProfile(none.client)).toEqual(row(none.user.id));
    expect(await ownProfile(one.client)).toEqual(row(one.user.id));
    expect(await ownProfile(many.client)).toEqual(row(many.user.id));
    expect(await ownProfile(receiving.client)).toEqual(row(receiving.user.id));
  });

  it('lists for HR the employees, and staff with another role only when they have assignments', async () => {
    const { admin, hr, field } = await cast();
    const mentor = await signInStaff(api, 'Employee');
    const formerMentor = await signInStaff(api, 'Employee');
    await seedAssignment(
      (await accepted(hr.client, field.id)).applicationId,
      formerMentor.user.id,
      '2030-01-01',
      '2030-01-31',
      'Completed',
    );
    await setRole(formerMentor.email, 'HR'); // given another role later: their record stays in the report

    const ids = (await allMentors(hr.client)).map((r) => r.employee.id);
    expect(ids).toContain(mentor.user.id);
    expect(ids).toContain(formerMentor.user.id);
    expect(ids).not.toContain(hr.user.id); // HR and Admin without assignments are not mentors
    expect(ids).not.toContain(admin.user.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows an employee only themself, whatever the request says', async () => {
    const { hr, field } = await cast();
    const me = await signInStaff(api, 'Employee');
    const other = await signInStaff(api, 'Employee');
    await seedAssignment(
      (await accepted(hr.client, field.id)).applicationId,
      other.user.id,
      '2031-01-01',
      '2031-01-31',
      'Active',
    );

    for (const query of ['', `?employeeId=${other.user.id}`, `?id=${other.user.id}`]) {
      const own = await ownProfile(me.client, query);
      expect(own).toEqual({ employee: { id: me.user.id, fullName: expect.any(String) }, trainees: 0, assignments: 0 });
    }
    // No route takes another employee's id, and the HR list is not theirs.
    expect((await me.client.get(`/api/employee/reports/mentor-profile/${other.user.id}`)).status).toBe(404);
    expect((await me.client.get('/api/hr/reports/mentor-profile')).status).toBe(403);
  });

  it('is for HR and employees only: Admin and trainees are refused, anonymous callers too', async () => {
    const { admin, hr } = await cast();
    const employee = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);

    expect((await hr.client.get('/api/employee/reports/mentor-profile')).status).toBe(403); // HR has the full list
    for (const client of [admin.client, trainee.client]) {
      for (const path of ['/api/hr/reports/mentor-profile', '/api/employee/reports/mentor-profile']) {
        expect((await client.get(path)).status, path).toBe(403);
      }
    }
    // No Admin route (NEW-02).
    expect((await admin.client.get('/api/admin/reports/mentor-profile')).status).toBe(404);
    for (const path of [
      '/api/hr/reports/mentor-profile',
      '/api/employee/reports/mentor-profile',
      '/api/admin/reports/mentor-profile',
    ]) {
      expect((await api.client().get(path)).status, path).toBe(401);
    }
    expect((await employee.client.get('/api/employee/reports/mentor-profile')).status).toBe(200);
  });

  it('changes nothing when read', async () => {
    const { hr, field } = await cast();
    const employee = await signInStaff(api, 'Employee');
    const { applicationId } = await accepted(hr.client, field.id);
    const assignmentId = await seedAssignment(applicationId, employee.user.id, '2031-01-01', '2031-01-31', 'Active');
    const ids = [employee.user.id, applicationId, assignmentId];
    const snapshot = () =>
      withDb(async (db) => ({
        rows: (
          await db.query(
            `SELECT id::text, xmin::text FROM employees WHERE id = ANY($1)
             UNION ALL SELECT id::text, xmin::text FROM training_applications WHERE id = ANY($1)
             UNION ALL SELECT id::text, xmin::text FROM assignments WHERE id = ANY($1) ORDER BY 1`,
            [ids],
          )
        ).rows,
        audit: (await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ANY($1)', [ids])).rows,
      }));

    const before = await snapshot();
    expect(before.rows).toHaveLength(3);
    await allMentors(hr.client);
    await ownProfile(employee.client);
    expect(await snapshot()).toEqual(before);
    for (const [client, path] of [
      [hr.client, '/api/hr/reports/mentor-profile'],
      [employee.client, '/api/employee/reports/mentor-profile'],
    ] as const) {
      expect((await client.post(path, {})).status).toBe(405);
    }
  });
});
