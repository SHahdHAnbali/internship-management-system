import { describe, expect, it } from 'vitest';
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

/**
 * Who sign-in writes are recorded as. Once an identity is verified (a valid Google ID token; a correct, usable trainee
 * code or link), the writes that follow are recorded as that user: the new session (and the browser's session it
 * replaces), a new staff account, and the trainee's use of the code and new account. Everything before verification
 * (code requests, wrong codes, refused tokens) stays Anonymous. Existing audit entries are never changed.
 */
const api = createTestApi();

/**
 * The token with one real byte of its signature changed. Editing the last base64url character is not enough: a 256-byte
 * signature leaves 4 unused bits in it, so some edits decode to the same bytes and the token stays valid.
 */
function withTamperedSignature(token: string): string {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const middle = bytes.length >> 1;
  bytes[middle] = bytes[middle]! ^ 0x01;
  const tampered = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${tampered}`;
}

const auditOf = (where: string, params: unknown[]) =>
  withDb((db) =>
    db.query<{
      table_name: string;
      operation: string;
      actor_type: string;
      actor_id: string | null;
      reason: string | null;
    }>(
      `SELECT table_name, operation, actor_type, actor_id, new_values->>'revoke_reason' AS reason
         FROM audit_logs WHERE ${where} ORDER BY id`,
      params,
    ),
  ).then((r) => r.rows);

const sessionIdsOf = (column: 'employee_id' | 'trainee_id', id: string) =>
  withDb((db) =>
    db.query<{ id: string }>(`SELECT id::text FROM user_sessions WHERE ${column} = $1 ORDER BY created_at, id`, [id]),
  ).then((r) => r.rows.map((row) => row.id));

const googleSignIn = async (client: TestClient, email: string, domain: string | null = COMPANY_DOMAIN) =>
  client.post('/api/auth/staff/google', { idToken: await api.google.issue(email, domain) });

describe('sign-in writes are recorded as the verified user', () => {
  it.each(['Admin', 'HR', 'Employee'] as const)(
    '%s: Google sign-in starts a session recorded as them',
    async (role) => {
      const { client, user, email } = await signInStaff(api, role);
      // Sign in again with the role in place (signInStaff grants it after the first sign-in).
      expect((await googleSignIn(client, email)).status).toBe(200);
      const sessions = await sessionIdsOf('employee_id', user.id);
      expect(sessions).toHaveLength(2);

      const rows = await auditOf("table_name = 'user_sessions' AND entity_id = ANY($1)", [sessions]);
      expect(rows.filter((r) => r.operation === 'INSERT')).toEqual([
        { table_name: 'user_sessions', operation: 'INSERT', actor_type: 'Staff', actor_id: user.id, reason: null },
        { table_name: 'user_sessions', operation: 'INSERT', actor_type: 'Staff', actor_id: user.id, reason: null },
      ]);
      expect(rows.every((r) => r.actor_type === 'Staff' && r.actor_id === user.id)).toBe(true);
    },
  );

  it('a first Google sign-in creates the staff account and its session as that person', async () => {
    const client = api.client();
    const email = uniqueEmail(COMPANY_DOMAIN);
    const signedIn = await body<{ id: string }>(await googleSignIn(client, email));
    expect(await auditOf("table_name = 'employees' AND entity_id = $1", [signedIn.id])).toEqual([
      { table_name: 'employees', operation: 'INSERT', actor_type: 'Staff', actor_id: signedIn.id, reason: null },
    ]);
    const [session] = await sessionIdsOf('employee_id', signedIn.id);
    expect(await auditOf('entity_id = $1', [session])).toEqual([
      { table_name: 'user_sessions', operation: 'INSERT', actor_type: 'Staff', actor_id: signedIn.id, reason: null },
    ]);
  });

  it('a trainee: the code request stays Anonymous; the verified code, new account and session are the trainee', async () => {
    const { user, email } = await signInTrainee(api); // e-mailed code
    const codes = await withDb((db) =>
      db.query<{ id: string }>('SELECT id::text FROM trainee_sign_in_codes WHERE email = $1', [email]),
    );
    const [session] = await sessionIdsOf('trainee_id', user.id);
    const rows = await auditOf('entity_id = ANY($1)', [[...codes.rows.map((r) => r.id), user.id, session]]);
    expect(rows.map(({ reason: _, ...r }) => r)).toEqual([
      { table_name: 'trainee_sign_in_codes', operation: 'INSERT', actor_type: 'Anonymous', actor_id: null },
      { table_name: 'trainee_sign_in_codes', operation: 'UPDATE', actor_type: 'Trainee', actor_id: user.id },
      { table_name: 'trainees', operation: 'INSERT', actor_type: 'Trainee', actor_id: user.id },
      { table_name: 'user_sessions', operation: 'INSERT', actor_type: 'Trainee', actor_id: user.id },
    ]);
  });

  it('a returning trainee signing in by link is recorded as the trainee', async () => {
    const { user, email } = await signInTrainee(api);
    const client = api.client();
    await client.post('/api/auth/trainee/request', { email });
    const { token } = api.emails.lastSignInFor(email);
    expect((await client.post('/api/auth/trainee/verify', { token })).status).toBe(200);
    const sessions = await sessionIdsOf('trainee_id', user.id);
    expect(sessions).toHaveLength(2);
    expect(await auditOf('entity_id = $1', [sessions[1]])).toEqual([
      { table_name: 'user_sessions', operation: 'INSERT', actor_type: 'Trainee', actor_id: user.id, reason: null },
    ]);
  });
});

describe('nothing unverified is recorded as a user', () => {
  it('a refused Google token creates nothing and records nothing', async () => {
    const email = uniqueEmail(COMPANY_DOMAIN);
    const client = api.client();
    const token = await api.google.issue(email, COMPANY_DOMAIN);
    const refused = await client.post('/api/auth/staff/google', { idToken: withTamperedSignature(token) });
    expect(refused.status).toBe(401);
    expect(await body(refused)).toMatchObject({ code: 'auth.invalid_token' });
    const accounts = await withDb((db) => db.query('SELECT id FROM employees WHERE email = $1', [email]));
    expect(accounts.rows).toEqual([]);

    // The same token untouched is accepted: the changed signature byte was the only reason for the refusal.
    expect((await client.post('/api/auth/staff/google', { idToken: token })).status).toBe(200);
  });

  it('a wrong trainee code is counted as Anonymous, and the account is not created', async () => {
    const email = uniqueEmail();
    const client = api.client();
    await client.post('/api/auth/trainee/request', { email });
    const { code } = api.emails.lastSignInFor(email);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await client.post('/api/auth/trainee/verify', { email, code: wrong })).status).toBe(400);
    expect((await client.post('/api/auth/trainee/verify', { token: 'not-a-real-token' })).status).toBe(400);

    const [codeRow] = (
      await withDb((db) =>
        db.query<{ id: string }>('SELECT id::text FROM trainee_sign_in_codes WHERE email = $1', [email]),
      )
    ).rows;
    expect((await auditOf('entity_id = $1', [codeRow!.id])).map(({ reason: _, ...r }) => r)).toEqual([
      { table_name: 'trainee_sign_in_codes', operation: 'INSERT', actor_type: 'Anonymous', actor_id: null },
      { table_name: 'trainee_sign_in_codes', operation: 'UPDATE', actor_type: 'Anonymous', actor_id: null },
    ]);
    expect((await withDb((db) => db.query('SELECT id FROM trainees WHERE email = $1', [email]))).rows).toEqual([]);
  });

  it('a Google user outside the staff domains has no account, so their session stays Anonymous', async () => {
    const client = api.client();
    const signedIn = await body<{ id: string; role: string | null }>(
      await googleSignIn(client, uniqueEmail('gmail.example'), null),
    );
    expect(signedIn.role).toBeNull();
    const subject = signedIn.id.replace(/^google:/, '');
    const sessions = await withDb((db) =>
      db.query<{ id: string }>('SELECT id::text FROM user_sessions WHERE google_subject = $1', [subject]),
    );
    expect(await auditOf('entity_id = $1', [sessions.rows[0]!.id])).toEqual([
      { table_name: 'user_sessions', operation: 'INSERT', actor_type: 'Anonymous', actor_id: null, reason: null },
    ]);
  });
});

describe('session replacement and sign-out', () => {
  it('another user signing in on the same browser replaces the session, as that user; sign-out is theirs too', async () => {
    const first = await signInStaff(api, 'Employee');
    const client = first.client; // the same browser
    const second = { email: uniqueEmail(COMPANY_DOMAIN) };
    const secondUser = await body<{ id: string }>(await googleSignIn(client, second.email));
    await client.post('/api/auth/sign-out');

    const [firstSession] = await sessionIdsOf('employee_id', first.user.id);
    const [secondSession] = await sessionIdsOf('employee_id', secondUser.id);
    const rows = await auditOf("table_name = 'user_sessions' AND entity_id = ANY($1)", [[firstSession, secondSession]]);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          table_name: 'user_sessions',
          operation: 'INSERT',
          actor_type: 'Staff',
          actor_id: first.user.id,
          reason: null,
        },
        // Replaced by the second user's verified sign-in, in the same statement as their new session.
        {
          table_name: 'user_sessions',
          operation: 'UPDATE',
          actor_type: 'Staff',
          actor_id: secondUser.id,
          reason: 'Replaced',
        },
        {
          table_name: 'user_sessions',
          operation: 'INSERT',
          actor_type: 'Staff',
          actor_id: secondUser.id,
          reason: null,
        },
        {
          table_name: 'user_sessions',
          operation: 'UPDATE',
          actor_type: 'Staff',
          actor_id: secondUser.id,
          reason: 'SignOut',
        },
      ]),
    );
    expect(rows).toHaveLength(4);
  });
});

describe('the Admin audit log shows who signed in', () => {
  it('names the user of a sign-in, without session ids, tokens or hashes', async () => {
    const admin = await signInStaff(api, 'Admin');
    await withDb((db) =>
      db.query("UPDATE employees SET full_name = 'Synthetic Signed-In Admin' WHERE id = $1", [admin.user.id]),
    );
    expect((await googleSignIn(admin.client, admin.email)).status).toBe(200);
    const trainee = await signInTrainee(api);

    const page = await body<{
      entries: {
        actorType: string;
        actorId: string;
        actorName: string | null;
        actorCurrentRole: string | null;
        entityId: string | null;
      }[];
    }>(await admin.client.get(`/api/admin/audit-logs?actorId=${admin.user.id}&table=user_sessions&operation=INSERT`));
    expect(page.entries.length).toBeGreaterThanOrEqual(2);
    expect(
      page.entries.every(
        (e) =>
          e.actorType === 'Staff' &&
          e.actorName === 'Synthetic Signed-In Admin' &&
          e.actorCurrentRole === 'Admin' &&
          e.entityId === null,
      ),
    ).toBe(true);

    const traineeEntries = await body<{ entries: { actorType: string; actorId: string }[] }>(
      await admin.client.get(`/api/admin/audit-logs?actorId=${trainee.user.id}`),
    );
    expect(traineeEntries.entries.length).toBeGreaterThanOrEqual(3); // code use, account, session
    expect(traineeEntries.entries.every((e) => e.actorType === 'Trainee')).toBe(true);

    const secrets = await withDb(async (db) => {
      const codes = await db.query<{ code_hash: string; token_hash: string }>(
        'SELECT code_hash, token_hash FROM trainee_sign_in_codes WHERE email = $1',
        [trainee.email],
      );
      const sessions = await db.query<{ id: string }>(
        'SELECT id::text FROM user_sessions WHERE employee_id = $1 OR trainee_id = $2',
        [admin.user.id, trainee.user.id],
      );
      return [...codes.rows.flatMap((r) => [r.code_hash, r.token_hash]), ...sessions.rows.map((r) => r.id)];
    });
    const text = JSON.stringify([page, traineeEntries]);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain(admin.email);
    expect(text).not.toContain(trainee.email);
  });
});

describe('existing audit entries', () => {
  it('are left as they were: the change applies to new sign-ins only', async () => {
    const snapshot = (ids?: string[]) =>
      withDb((db) =>
        db.query<{ id: string; actor_type: string; actor_id: string | null; xmin: string }>(
          `SELECT id::text, actor_type, actor_id, xmin::text FROM audit_logs
            ${ids ? 'WHERE id = ANY($1::bigint[])' : ''} ORDER BY audit_logs.id`,
          ids ? [ids] : [],
        ),
      ).then((r) => r.rows);
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await signInStaff(api, 'Employee');
    await signInTrainee(api);
    // Exactly the entries that existed before, unchanged (actor, and no rewrite: same row version).
    expect(await snapshot(before.map((r) => r.id))).toEqual(before);
  });
});
