import { expect } from 'vitest';
import { body, type TestClient, unique, withDb } from './helpers';

/** Shared seeding for the report tests: real endpoints for applications, direct inserts (actor System) for assignments. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]); // "%PDF-1.7\n"

export async function newField(admin: TestClient) {
  return body<{ id: string; name: string }>(
    await admin.post('/api/admin/fields', { name: unique('Field'), description: null }),
  );
}

/** Submits an application (PDF §4 form with a CV) as the signed-in trainee, returning its id. */
export async function submitApplication(trainee: TestClient, fieldId: string, fullName = 'Report Trainee') {
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
  const submitted = await trainee.post('/api/trainee/applications', form);
  expect(submitted.status).toBe(201);
  return (await body<{ id: string }>(submitted)).id;
}

/** An assignment as stored, with the given dates and status (the lifecycle actions that would set them are not built). */
export async function seedAssignment(
  applicationId: string,
  employeeId: string,
  start: string,
  end: string,
  status: string,
) {
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
