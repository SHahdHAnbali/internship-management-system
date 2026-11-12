import { describe, expect, it } from 'vitest';
import { body, COMPANY_DOMAIN, createTestApi, signInStaff, signInTrainee, uniqueEmail, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * AD-42 as amended by the owner (2026-11-12): B1 an existing trainee may also sign in with Google when the verified
 * e-mail matches exactly and is not in a staff domain; B2 staff domains keep the staff flow and take precedence; B3 any
 * other external Google account stays role-less, nothing created. The e-mailed code keeps working.
 */
const api = createTestApi();

const google = (email: string, hd: string | null, options: { emailVerified?: boolean; sub?: string } = {}) =>
  api.google.issue(email, hd, {
    emailVerified: options.emailVerified ?? true,
    claims: { sub: options.sub ?? `sub-${crypto.randomUUID()}` },
  });

const counts = (email: string) =>
  withDb((db) =>
    db.query<{ trainees: number; employees: number }>(
      `SELECT (SELECT count(*) FROM trainees WHERE email = $1)::int AS trainees,
              (SELECT count(*) FROM employees WHERE email = $1)::int AS employees`,
      [email],
    ),
  ).then((r) => r.rows[0]!);

describe('B1: an existing trainee signs in with Google', () => {
  it('reaches the same trainee account and its applications; nothing is created; staff APIs stay forbidden', async () => {
    const admin = await signInStaff(api, 'Admin');
    const field = await newField(admin.client);
    const email = uniqueEmail('gmail.com');
    const byCode = await signInTrainee(api, email);
    const applicationId = await submitApplication(byCode.client, field.id);

    const client = api.client();
    // Upper case and spaces: the verified e-mail is normalised before matching.
    const response = await client.post('/api/auth/staff/google', {
      idToken: await google(` ${email.toUpperCase()} `, null),
    });
    expect(response.status).toBe(200);
    const user = await body(response);
    expect(user).toEqual({ id: byCode.user.id, role: 'Trainee', email, name: null });
    expect(JSON.stringify(user)).not.toMatch(/eyJ/); // no token in the response
    expect(await body(await client.get('/api/auth/me'))).toEqual(user);

    const applications = await body<{ id: string }[]>(await client.get('/api/trainee/applications'));
    expect(applications.map((a) => a.id)).toEqual([applicationId]);
    expect(await counts(email)).toEqual({ trainees: 1, employees: 0 });

    // The session belongs to the trainee and its creation is audited as the trainee.
    const session = await withDb((db) =>
      db.query<{ trainee_id: string; actor_type: string; actor_id: string }>(
        `SELECT s.trainee_id, l.actor_type, l.actor_id FROM user_sessions s
           JOIN audit_logs l ON l.table_name = 'user_sessions' AND l.entity_id = s.id::text AND l.operation = 'INSERT'
          WHERE s.trainee_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
        [byCode.user.id],
      ),
    );
    expect(session.rows[0]).toEqual({ trainee_id: byCode.user.id, actor_type: 'Trainee', actor_id: byCode.user.id });

    for (const url of ['/api/hr/applications', '/api/hr/assignments', '/api/employee/trainees', '/api/admin/users']) {
      expect((await client.get(url)).status, url).toBe(403);
    }
  });

  it('the e-mailed code still works afterwards, for the same account', async () => {
    const email = uniqueEmail('trainee.example');
    const first = await signInTrainee(api, email);
    expect((await api.client().post('/api/auth/staff/google', { idToken: await google(email, null) })).status).toBe(
      200,
    );
    const again = await signInTrainee(api, email);
    expect(again.user.id).toBe(first.user.id);
    expect(await counts(email)).toEqual({ trainees: 1, employees: 0 });
  });

  it('an unverified Google e-mail is refused, even when a trainee has that address', async () => {
    const email = uniqueEmail('gmail.com');
    await signInTrainee(api, email);
    const client = api.client();
    const response = await client.post('/api/auth/staff/google', {
      idToken: await google(email, null, { emailVerified: false }),
    });
    expect(response.status).toBe(401);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });
});

describe('B2: staff domains keep the staff flow and take precedence', () => {
  it('a staff-domain Google account becomes staff (Employee), never the trainee with the same address', async () => {
    const email = uniqueEmail(COMPANY_DOMAIN);
    const trainee = await signInTrainee(api, email);
    const response = await api
      .client()
      .post('/api/auth/staff/google', { idToken: await google(email, COMPANY_DOMAIN) });
    expect(response.status).toBe(200);
    const user = await body<{ id: string; role: string }>(response);
    expect(user.role).toBe('Employee');
    expect(user.id).not.toBe(trainee.user.id);
    expect(await counts(email)).toEqual({ trainees: 1, employees: 1 }); // the trainee record is untouched
  });

  it('an address in a staff domain without the Workspace claim (or in a sub-domain) never matches a trainee', async () => {
    for (const email of [uniqueEmail(COMPANY_DOMAIN), uniqueEmail(`mail.${COMPANY_DOMAIN}`)]) {
      await signInTrainee(api, email);
      const response = await api.client().post('/api/auth/staff/google', { idToken: await google(email, null) });
      expect(response.status).toBe(200);
      expect((await body<{ role: string | null }>(response)).role, email).toBeNull();
      expect(await counts(email)).toEqual({ trainees: 1, employees: 0 });
    }
  });

  it('existing HR and Admin keep their roles through Google; nothing is granted by matching', async () => {
    for (const role of ['HR', 'Admin'] as const) {
      const staff = await signInStaff(api, role);
      const again = await api.client().post('/api/auth/staff/google', {
        idToken: await google(staff.email, COMPANY_DOMAIN),
      });
      expect((await body<{ role: string }>(again)).role).toBe(role);
    }
  });
});

describe('B3: an external Google account without a trainee account', () => {
  it('stays role-less: no trainee or employee is created', async () => {
    const email = uniqueEmail('gmail.com');
    const client = api.client();
    const response = await client.post('/api/auth/staff/google', { idToken: await google(email, null) });
    expect(response.status).toBe(200);
    expect(await body<{ role: string | null }>(response)).toMatchObject({ role: null, email });
    expect(await counts(email)).toEqual({ trainees: 0, employees: 0 });
    expect((await client.get('/api/trainee/applications')).status).toBe(403);
  });
});
