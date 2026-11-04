import { describe, expect, it } from 'vitest';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, unique, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * What the audit log records for writes that had no audit assertions: who acted, the operation and table, and the
 * values before and after (PDF §8 AuditLog: user, action, entity, value before and after, time). Synthetic data only.
 */
const api = createTestApi();

interface AuditRow {
  operation: string;
  table_name: string;
  actor_type: string;
  actor_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown>;
}

const auditOf = (where: string, params: unknown[]) =>
  withDb((db) =>
    db.query<AuditRow>(
      `SELECT operation, table_name, actor_type, actor_id, old_values, new_values FROM audit_logs WHERE ${where} ORDER BY id`,
      params,
    ),
  ).then((r) => r.rows);

describe('audit: Admin configuration', () => {
  it('an evaluation criterion update records the Admin and only the changed values, before and after', async () => {
    const admin = await signInStaff(api, 'Admin');
    const name = unique('Criterion');
    const created = await body<{ id: string }>(
      await admin.client.post('/api/admin/evaluation-criteria', { name, weight: 1, sortOrder: 1 }),
    );
    const updated = await admin.client.put(`/api/admin/evaluation-criteria/${created.id}`, {
      name,
      weight: 2.5,
      sortOrder: 3,
    });
    expect(updated.status).toBe(200);

    const rows = await auditOf("table_name = 'evaluation_criteria' AND entity_id = $1", [created.id]);
    expect(rows.map((r) => [r.operation, r.actor_type, r.actor_id])).toEqual([
      ['INSERT', 'Staff', admin.user.id],
      ['UPDATE', 'Staff', admin.user.id],
    ]);
    const update = rows[1]!;
    // Only what changed (the name did not); numbers as stored.
    expect(Object.keys(update.new_values).sort()).toEqual(['sort_order', 'weight']);
    expect(Number(update.old_values!.weight)).toBe(1);
    expect(Number(update.new_values.weight)).toBe(2.5);
    expect(update.old_values!.sort_order).toBe(1);
    expect(update.new_values.sort_order).toBe(3);
  });
});

describe('audit: training applications', () => {
  async function cast() {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    return { admin, hr, field: await newField(admin.client) };
  }

  it('a rejection records HR, the status change, the reason and the decision', async () => {
    const { hr, field } = await cast();
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, field.id, 'Synthetic Applicant');
    expect(
      (await hr.client.post(`/api/hr/applications/${applicationId}/reject`, { reason: 'Synthetic reason' })).status,
    ).toBe(200);

    const rows = await auditOf("table_name = 'training_applications' AND entity_id = $1", [applicationId]);
    expect(rows.map((r) => [r.operation, r.actor_type, r.actor_id])).toEqual([
      ['INSERT', 'Trainee', trainee.user.id],
      ['UPDATE', 'Staff', hr.user.id],
    ]);
    const rejection = rows[1]!;
    expect(rejection.old_values).toMatchObject({ status: 'Submitted', rejection_reason: null, decided_by_id: null });
    expect(rejection.new_values).toMatchObject({
      status: 'Rejected',
      rejection_reason: 'Synthetic reason',
      decided_by_id: hr.user.id,
    });
    expect(rejection.new_values.decided_at).toEqual(expect.any(String));
  });

  it('the first application records the trainee profile as an update by the trainee; a later one changes nothing', async () => {
    const { field } = await cast();
    const trainee = await signInTrainee(api);
    await submitApplication(trainee.client, field.id, 'Synthetic Profile Name');
    await submitApplication(trainee.client, field.id, 'A Different Name'); // the profile is kept (AD-47)

    const rows = await auditOf("table_name = 'trainees' AND entity_id = $1", [trainee.user.id]);
    expect(rows.map((r) => [r.operation, r.actor_type, r.actor_id])).toEqual([
      ['INSERT', 'Trainee', trainee.user.id], // the account, at sign-in
      ['UPDATE', 'Trainee', trainee.user.id], // the profile, from the first application only
    ]);
    const profile = rows[1]!;
    expect(profile.old_values).toEqual({
      full_name: null,
      phone: null,
      university: null,
      major: null,
      study_year: null,
    });
    expect(profile.new_values).toEqual({
      full_name: 'Synthetic Profile Name',
      phone: '000-0000',
      university: 'Example University',
      major: 'Computer Engineering',
      study_year: 'Fourth year',
    });
  });

  it('an uploaded file is recorded by its metadata only, never its content', async () => {
    const { field } = await cast();
    const trainee = await signInTrainee(api);
    const content = 'SYNTHETIC-LETTER-CONTENT-7f3a';
    const letterBytes = new TextEncoder().encode(content);
    const form = new FormData();
    for (const [name, value] of Object.entries({
      fullName: 'Synthetic Uploader',
      phone: '000-0000',
      university: 'Example University',
      major: 'Computer Engineering',
      studyYear: 'Fourth year',
      fieldId: field.id,
      availableFrom: '2031-01-01',
      availableTo: '2031-06-30',
      hours: '240',
      mandatoryForUniversity: 'false',
    })) {
      form.append(name, value);
    }
    form.append(
      'cv',
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'cv.pdf', { type: 'application/pdf' }),
    );
    form.append('letters', new File([letterBytes], 'letter.txt', { type: 'text/plain' }));
    const submitted = await (trainee.client as TestClient).post('/api/trainee/applications', form);
    expect(submitted.status).toBe(201);
    const { id: applicationId } = await body<{ id: string }>(submitted);

    const rows = await auditOf("table_name = 'application_attachments' AND new_values->>'application_id' = $1", [
      applicationId,
    ]);
    expect(rows.map((r) => [r.operation, r.actor_type, r.actor_id, r.old_values])).toEqual([
      ['INSERT', 'Trainee', trainee.user.id, null],
      ['INSERT', 'Trainee', trainee.user.id, null],
    ]);
    for (const row of rows) {
      expect(Object.keys(row.new_values).sort()).toEqual([
        'application_id',
        'content_type',
        'file_name',
        'id',
        'kind',
        'sha256',
        'size_bytes',
        'storage_key',
        'uploaded_at',
      ]);
    }
    const letter = rows.find((r) => r.new_values.kind === 'UniversityLetter')!;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', letterBytes));
    expect(letter.new_values).toMatchObject({
      file_name: 'letter.txt',
      content_type: 'text/plain',
      size_bytes: letterBytes.length,
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
    });
    // The content itself is never in the audit log, in any form.
    const text = JSON.stringify(rows);
    expect(text).not.toContain(content);
    expect(text).not.toContain(btoa(content));
  });
});
