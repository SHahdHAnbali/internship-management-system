import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { newTicket, protectTicket, unprotectTicket } from '../src/auth/session';
import { loadSettings, type Bindings } from '../src/config';
import { Database, type AuditActor } from '../src/db';
import { emailSenderFor, logEmailSender, unconfiguredEmailSender } from '../src/email';
import { revokeSession, startSession } from '../src/features/auth/sessions';
import {
  CLIENT_ID,
  COMPANY_DOMAIN,
  body,
  createTestApi,
  setRole,
  signInStaff,
  signInTrainee,
  type TestClient,
  uniqueEmail,
  withDb,
} from './helpers';

/**
 * Authentication and authorization end-to-end with the real session cookie: staff Google sign-in (company domain only,
 * first sign-in = Employee), trainee one-time link/code (15 minutes, single use), role enforcement and isolation.
 * Port of Ims.IntegrationTests.AuthApiTests, plus the session cookie and Google token checks.
 */
const api = createTestApi();
const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789';
/** One day, in minutes. */
const DAY = 24 * 60;

/** The test database URL as production would require it (the setting check only; no connection is made). */
function tlsDatabaseUrl(): string {
  return (env as unknown as Bindings).DATABASE_URL!.replace('sslmode=disable', 'sslmode=verify-full');
}

describe('staff: Google sign-in', () => {
  it('first sign-in from the company domain creates an Employee; signing in again reuses the account', async () => {
    const email = uniqueEmail(COMPANY_DOMAIN);
    const client = api.client();

    const response = await client.post('/api/auth/staff/google', {
      idToken: await api.google.issue(email, COMPANY_DOMAIN),
    });
    expect(response.status).toBe(200);
    const user = await body(response);
    expect(user).toMatchObject({ role: 'Employee', email, name: 'Test User' });
    expect(await body(await client.get('/api/auth/me'))).toEqual(user);

    const again = api.client();
    const second = await again.post('/api/auth/staff/google', {
      idToken: await api.google.issue(email.toUpperCase(), COMPANY_DOMAIN),
    });
    expect((await body(second)).id).toBe(user.id);
    const count = await withDb((db) => db.query('SELECT count(*)::int AS n FROM employees WHERE email = $1', [email]));
    expect(count.rows[0].n).toBe(1);
  });

  it.each([
    ['gmail.com', null],
    ['other.example', 'other.example'],
    [COMPANY_DOMAIN, null], // personal account using the company address, without the Workspace "hd" claim
    ['other.example', COMPANY_DOMAIN], // Workspace claim but an address outside the domain
  ])('signs in an @%s account (hd %s) as an ordinary user: no role, no record, no staff access', async (domain, hd) => {
    const email = uniqueEmail(domain);
    const client = api.client();
    const idToken = await api.google.issue(email.toUpperCase(), hd, { claims: { sub: `sub-${email}` } });

    const response = await client.post('/api/auth/staff/google', { idToken });

    expect(response.status).toBe(200);
    const user = await body(response);
    expect(user).toEqual({ id: `google:sub-${email}`, role: null, email, name: 'Test User' });
    expect(await body(await client.get('/api/auth/me'))).toEqual(user);
    for (const url of [
      '/api/admin/fields',
      '/api/admin/users',
      '/api/admin/evaluation-criteria',
      '/api/admin/settings/notifications',
    ]) {
      expect((await client.get(url)).status, url).toBe(403);
    }

    expect((await client.put(`/api/admin/users/${crypto.randomUUID()}/role`, { role: 'Admin' })).status).toBe(403);
    expect((await client.post('/api/admin/fields', { name: 'x' })).status).toBe(403);

    // No account is created (no staff, no trainee): only the session row (AD-44), which holds the Google subject and
    // no e-mail or name.
    const rows = await withDb((db) =>
      db.query(
        `SELECT (SELECT count(*) FROM employees WHERE email = $1)::int AS employees,
                (SELECT count(*) FROM trainees WHERE email = $1)::int AS trainees,
                (SELECT count(*) FROM user_sessions WHERE google_subject = $2)::int AS sessions,
                (SELECT count(*) FROM audit_logs WHERE table_name <> 'user_sessions'
                   AND new_values::text LIKE '%' || $1 || '%')::int AS audit`,
        [email, `sub-${email}`],
      ),
    );
    expect(rows.rows[0]).toEqual({ employees: 0, trainees: 0, sessions: 1, audit: 0 });

    expect((await client.post('/api/auth/sign-out')).status).toBe(204);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('an ordinary Google user who later signs in again stays an ordinary user', async () => {
    const email = uniqueEmail('gmail.com');
    for (let i = 0; i < 2; i++) {
      const response = await api
        .client()
        .post('/api/auth/staff/google', { idToken: await api.google.issue(email, null) });
      expect((await body(response)).role).toBeNull();
    }

    expect((await withDb((db) => db.query('SELECT 1 FROM employees WHERE email = $1', [email]))).rowCount).toBe(0);
  });

  it('the ordinary-user session is renewed and expires like any other, and cannot be forged into a role', async () => {
    const client = api.client();
    await client.post('/api/auth/staff/google', { idToken: await api.google.issue(uniqueEmail('gmail.com'), null) });
    api.clock.advanceMinutes(61);
    try {
      const renewed = await client.get('/api/auth/me');
      expect(renewed.status).toBe(200);
      expect(renewed.headers.getSetCookie()).toHaveLength(1);
      expect((await body(renewed)).role).toBeNull();
      api.clock.advanceMinutes(7 * DAY + 1);
      expect((await client.get('/api/auth/me')).status).toBe(401);
    } finally {
      api.clock.offsetMs = 0;
    }

    // A ticket naming a role must be a real staff/trainee record; an ordinary user's id never is.
    const forged = await protectTicket(
      newTicket(
        { id: 'google:123', role: 'Admin', email: 'x@gmail.com', name: null },
        { id: crypto.randomUUID(), expiresAt: new Date(api.clock.now().getTime() + 30 * DAY * 60_000) },
        api.clock.now(),
        7 * DAY,
      ),
      TEST_SESSION_SECRET,
    );
    const response = await api.fetch(
      new Request('http://localhost/api/admin/users', { headers: { cookie: `ims.session=${forged}` } }),
    );
    expect(response.status).toBe(401);
  });

  it.each(['HR', 'Admin'] as const)('an existing %s keeps that role when signing in again', async (role) => {
    const { email } = await signInStaff(api, role);
    const again = await api
      .client()
      .post('/api/auth/staff/google', { idToken: await api.google.issue(email, COMPANY_DOMAIN) });
    expect((await body(again)).role).toBe(role);
  });

  it('uses GOOGLE_HOSTED_DOMAIN from configuration (stu.najah.edu as deployed)', async () => {
    const signIn = async (email: string, hd: string | null) =>
      body(
        await api.fetch(
          new Request('http://localhost/api/auth/staff/google', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idToken: await api.google.issue(email, hd) }),
          }),
          { GOOGLE_HOSTED_DOMAIN: 'stu.najah.edu' },
        ),
      );

    const staff = await signIn(uniqueEmail('stu.najah.edu'), 'stu.najah.edu');
    expect(staff.role).toBe('Employee');
    expect((await signIn(uniqueEmail('stu.najah.edu'), null)).role).toBeNull();
    expect((await signIn(uniqueEmail('najah.edu'), 'najah.edu')).role).toBeNull();
    expect((await signIn(uniqueEmail(COMPANY_DOMAIN), COMPANY_DOMAIN)).role).toBeNull(); // the test domain is not staff here
  });

  it('rejects forged tokens and unverified e-mails', async () => {
    const client = api.client();
    const forged = await client.post('/api/auth/staff/google', { idToken: 'forged' });
    expect(forged.status).toBe(401);
    expect(await body(forged)).toEqual({
      status: 401,
      detail: 'The Google sign-in could not be verified.',
      code: 'auth.invalid_token',
    });

    const unverified = await client.post('/api/auth/staff/google', {
      idToken: await api.google.issue(`x@${COMPANY_DOMAIN}`, COMPANY_DOMAIN, { emailVerified: false }),
    });
    expect(unverified.status).toBe(401);
    expect((await body(unverified)).code).toBe('auth.email_not_verified');
  });

  it('verifies the token like Google.Apis.Auth: signature, issuer, audience, expiry, issued-at, algorithm', async () => {
    const email = uniqueEmail(COMPANY_DOMAIN);
    const now = Math.floor(Date.now() / 1000);
    const valid = await api.google.issue(email, COMPANY_DOMAIN);
    const [header, payload] = valid.split('.');
    const otherKey = await createTestApi().google.issue(email, COMPANY_DOMAIN); // signed by another key, same kid
    const cases: [string, string][] = [
      ['tampered payload', `${header}.${payload}x.${valid.split('.')[2]}`],
      ['signed by another key', otherKey],
      ['wrong issuer', await api.google.issue(email, COMPANY_DOMAIN, { claims: { iss: 'https://evil.example' } })],
      ['other audience', await api.google.issue(email, COMPANY_DOMAIN, { claims: { aud: 'other-client' } })],
      [
        'one untrusted audience',
        await api.google.issue(email, COMPANY_DOMAIN, { claims: { aud: [CLIENT_ID, 'other'] } }),
      ],
      ['expired', await api.google.issue(email, COMPANY_DOMAIN, { claims: { exp: now - 1 } })],
      ['issued 60 s in the future', await api.google.issue(email, COMPANY_DOMAIN, { claims: { iat: now + 60 } })],
      ['alg none', `${btoa(JSON.stringify({ alg: 'none', kid: api.google.kid })).replace(/=+$/, '')}.${payload}.`],
      ['unknown key id', await api.google.issue(email, COMPANY_DOMAIN, { header: { kid: 'other' } })],
    ];
    for (const [name, idToken] of cases) {
      const response = await api.client().post('/api/auth/staff/google', { idToken });
      expect(response.status, name).toBe(401);
    }

    // Accepted: legacy issuer form, audience array of our client id, issued-at within the 30 s tolerance.
    for (const claims of [{ iss: 'accounts.google.com' }, { aud: [CLIENT_ID] }, { iat: now + 20 }]) {
      const response = await api.client().post('/api/auth/staff/google', {
        idToken: await api.google.issue(email, COMPANY_DOMAIN, { claims }),
      });
      expect(response.status, JSON.stringify(claims)).toBe(200);
    }
  });

  it('uses the e-mail as the name when Google sends none', async () => {
    const email = uniqueEmail(COMPANY_DOMAIN);
    const response = await api.client().post('/api/auth/staff/google', {
      idToken: await api.google.issue(email, COMPANY_DOMAIN, { name: null }),
    });
    expect((await body(response)).name).toBe(email);
  });

  it('is 503 when Google sign-in is not configured', async () => {
    const response = await api.fetch(
      new Request('http://localhost/api/auth/staff/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: 'x' }),
      }),
      { GOOGLE_CLIENT_ID: '' },
    );
    expect(response.status).toBe(503);
    expect((await body(response)).code).toBe('auth.google_not_configured');
  });

  it('roles come from PostgreSQL and changes apply to the current session', async () => {
    const { client, email } = await signInStaff(api, 'Employee');
    expect((await client.get('/api/admin/fields')).status).toBe(403);

    await setRole(email, 'Admin');
    const ok = await client.get('/api/admin/fields');
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie()).toHaveLength(1); // the cookie is re-issued with the new role
    expect((await body(await client.get('/api/auth/me'))).role).toBe('Admin');

    await setRole(email, 'HR');
    expect((await client.get('/api/admin/fields')).status).toBe(403);
  });

  it('only an Admin can grant higher roles', async () => {
    const employee = await signInStaff(api, 'Employee');
    const selfPromotion = await employee.client.put(`/api/admin/users/${employee.user.id}/role`, { role: 'Admin' });
    expect(selfPromotion.status).toBe(403);

    const admin = await signInStaff(api, 'Admin');
    const granted = await admin.client.put(`/api/admin/users/${employee.user.id}/role`, { role: 'HR' });
    expect(granted.status).toBe(200);
    expect((await body(await employee.client.get('/api/auth/me'))).role).toBe('HR');
  });
});

describe('staff: two Google Workspace domains (stu.najah.edu and progineer.net, AD-45)', () => {
  const DOMAINS = { GOOGLE_HOSTED_DOMAIN: 'stu.najah.edu,progineer.net' };

  /** Google sign-in with the two staff domains configured; returns the response and the session cookie it set. */
  async function googleSignIn(
    email: string,
    hd: string | null,
    options: { emailVerified?: boolean; cookie?: string; bindings?: Partial<Bindings> } = {},
  ) {
    const response = await api.fetch(
      new Request('http://localhost/api/auth/staff/google', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.cookie ? { cookie: `ims.session=${options.cookie}` } : {}),
        },
        body: JSON.stringify({
          idToken: await api.google.issue(email, hd, { emailVerified: options.emailVerified ?? true }),
        }),
      }),
      options.bindings ?? DOMAINS,
    );
    const cookie = /^ims\.session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    return { response, cookie, user: response.status === 200 ? await body(response) : null };
  }

  const me = (cookie: string, bindings: Partial<Bindings> = DOMAINS) =>
    api.fetch(new Request('http://localhost/api/auth/me', { headers: { cookie: `ims.session=${cookie}` } }), bindings);
  const employee = (email: string) =>
    withDb((db) => db.query<{ role: string }>('SELECT role FROM employees WHERE email = $1', [email])).then(
      (r) => r.rows,
    );

  it.each(['stu.najah.edu', 'progineer.net'])(
    'a first sign-in from %s creates a staff account with the Employee role',
    async (domain) => {
      const email = uniqueEmail(domain);
      const { response, user, cookie } = await googleSignIn(email, domain);

      expect(response.status).toBe(200);
      expect(user).toMatchObject({ role: 'Employee', email });
      expect(await employee(email)).toEqual([{ role: 'Employee' }]);
      expect(await body(await me(cookie!))).toMatchObject({ role: 'Employee', email });
    },
  );

  it.each([
    ['the hd of one staff domain with an e-mail of the other', 'stu.najah.edu', 'progineer.net'],
    ['the hd of one staff domain with an e-mail of the other (reversed)', 'progineer.net', 'stu.najah.edu'],
    ['a staff e-mail without a Workspace hd (a personal Google account)', 'progineer.net', null],
    ['a subdomain of a staff domain', 'mail.progineer.net', 'mail.progineer.net'],
    ['a look-alike domain', 'progineer.net.example', 'progineer.net.example'],
    ['a domain that only ends with a staff domain', 'xprogineer.net', 'xprogineer.net'],
    ['an e-mail in a staff domain with a look-alike hd', 'progineer.net', 'progineer.net.example'],
  ])('%s is not staff: signed in without a role and no staff account', async (_case, emailDomain, hd) => {
    const email = uniqueEmail(emailDomain);
    const { response, user } = await googleSignIn(email, hd);

    expect(response.status).toBe(200);
    expect(user!.role).toBeNull();
    expect(await employee(email)).toEqual([]);
  });

  it('accounts of other domains still sign in without a role (AD-42), with no staff access', async () => {
    const { user, cookie } = await googleSignIn(uniqueEmail('gmail.com'), null);
    expect(user!.role).toBeNull();
    const fields = await api.fetch(
      new Request('http://localhost/api/admin/fields', { headers: { cookie: `ims.session=${cookie}` } }),
      DOMAINS,
    );
    expect(fields.status).toBe(403);
  });

  it('a staff-domain account whose e-mail Google has not verified is refused', async () => {
    const email = uniqueEmail('progineer.net');
    const { response } = await googleSignIn(email, 'progineer.net', { emailVerified: false });
    expect(response.status).toBe(401);
    expect(await employee(email)).toEqual([]);
  });

  it('a forged token naming a staff domain is refused', async () => {
    const valid = await api.google.issue(uniqueEmail('progineer.net'), 'progineer.net');
    const [header, payload, signature] = valid.split('.');
    const forgedPayload = btoa(
      JSON.stringify({
        ...JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))),
        email: 'someone@progineer.net',
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const response = await api.fetch(
      new Request('http://localhost/api/auth/staff/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: `${header}.${forgedPayload}.${signature}` }),
      }),
      DOMAINS,
    );
    expect(response.status).toBe(401);
  });

  it('the domain never grants Admin or HR; an existing Admin keeps the role and their session; an Admin can promote', async () => {
    // An Admin of stu.najah.edu, signed in while only that domain was configured.
    const adminEmail = uniqueEmail('stu.najah.edu');
    const first = await googleSignIn(adminEmail, 'stu.najah.edu', {
      bindings: { GOOGLE_HOSTED_DOMAIN: 'stu.najah.edu' },
    });
    await setRole(adminEmail, 'Admin');

    // After the second domain is added: the existing session still works with the same role, and so does a new sign-in.
    expect(await body(await me(first.cookie!))).toMatchObject({ role: 'Admin', email: adminEmail });
    const again = await googleSignIn(adminEmail, 'stu.najah.edu');
    expect(again.user!.role).toBe('Admin');

    // A progineer.net user starts as Employee, never more, and cannot reach the Admin API.
    const newcomer = uniqueEmail('progineer.net');
    const signedIn = await googleSignIn(newcomer, 'progineer.net');
    expect(signedIn.user!.role).toBe('Employee');
    const denied = await api.fetch(
      new Request('http://localhost/api/admin/users', { headers: { cookie: `ims.session=${signedIn.cookie}` } }),
      DOMAINS,
    );
    expect(denied.status).toBe(403);

    // Only an Admin's explicit change makes them Admin, and it applies to their current session at once.
    const promoted = await api.fetch(
      new Request(`http://localhost/api/admin/users/${(signedIn.user as { id: string }).id}/role`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: `ims.session=${again.cookie}` },
        body: JSON.stringify({ role: 'Admin' }),
      }),
      DOMAINS,
    );
    expect(promoted.status).toBe(200);
    expect(await body(await me(signedIn.cookie!))).toMatchObject({ role: 'Admin', email: newcomer });
    expect(await employee(adminEmail)).toEqual([{ role: 'Admin' }]);
  });

  it('reads the domain list case- and space-insensitively, without duplicates, and refuses an invalid entry', async () => {
    const config = (value: string) =>
      api.fetch(new Request('http://localhost/api/auth/config'), { GOOGLE_HOSTED_DOMAIN: value });
    expect((await body(await config(' STU.najah.edu , Progineer.NET ,progineer.net'))).googleHostedDomains).toEqual([
      'stu.najah.edu',
      'progineer.net',
    ]);
    for (const invalid of [
      'stu.najah.edu,,progineer.net',
      'stu.najah.edu, ',
      '@progineer.net',
      'progineer net',
      'localhost',
    ]) {
      expect((await config(invalid)).status, invalid).toBe(500);
    }

    const email = uniqueEmail('progineer.net');
    const upperCase = await googleSignIn(email, 'PROGINEER.NET', {
      bindings: { GOOGLE_HOSTED_DOMAIN: ' Progineer.NET ' },
    });
    expect(upperCase.user!.role).toBe('Employee');
  });
});

describe('one-time initial Admin: mohammad.abujoudeh@progineer.net (AD-46)', () => {
  const DOMAINS = { GOOGLE_HOSTED_DOMAIN: 'stu.najah.edu,progineer.net' };
  const MOHAMMAD = 'mohammad.abujoudeh@progineer.net';

  async function googleSignIn(
    email: string,
    hd: string | null,
    options: { emailVerified?: boolean; claims?: Record<string, unknown>; token?: string } = {},
  ) {
    const idToken =
      options.token ??
      (await api.google.issue(email, hd, { emailVerified: options.emailVerified ?? true, claims: options.claims }));
    const response = await api.fetch(
      new Request('http://localhost/api/auth/staff/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }),
      DOMAINS,
    );
    const cookie = /^ims\.session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    return { status: response.status, cookie, user: response.status === 200 ? await body(response) : null };
  }

  const call = (method: string, path: string, cookie: string, payload?: unknown) =>
    api.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { cookie: `ims.session=${cookie}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      }),
      DOMAINS,
    );
  const accounts = (email: string) =>
    withDb((db) =>
      db.query<{ id: string; role: string }>('SELECT id, role FROM employees WHERE email = $1', [email]),
    ).then((r) => r.rows);
  const audit = (employeeId: string) =>
    withDb((db) =>
      db.query<{
        operation: string;
        actor_type: string;
        actor_id: string | null;
        old_role: string | null;
        new_role: string;
      }>(
        `SELECT operation, actor_type, actor_id, old_values->>'role' AS old_role, new_values->>'role' AS new_role
           FROM audit_logs WHERE table_name = 'employees' AND entity_id = $1 ORDER BY id`,
        [employeeId],
      ),
    ).then((r) => r.rows);

  it('is created as Admin once, by its own verified Google sign-in; afterwards only the saved role counts', async () => {
    // 1. Nothing but the exact, verified progineer.net Workspace identity is ever made Admin, and failures create nothing.
    const valid = await api.google.issue(MOHAMMAD, 'progineer.net');
    const [header, payload, signature] = valid.split('.');
    const tampered = `${header}.${payload}x.${signature}`;
    expect((await googleSignIn(MOHAMMAD, 'progineer.net', { emailVerified: false })).status).toBe(401);
    expect((await googleSignIn(MOHAMMAD, 'progineer.net', { token: tampered })).status).toBe(401);
    expect((await googleSignIn(MOHAMMAD, 'progineer.net', { claims: { aud: 'another-client' } })).status).toBe(401);
    expect((await googleSignIn(MOHAMMAD, null)).user!.role).toBeNull(); // a personal Google account using the address
    expect((await googleSignIn(MOHAMMAD, 'stu.najah.edu')).user!.role).toBeNull(); // hd of the other staff domain
    expect(await accounts(MOHAMMAD)).toEqual([]);
    for (const [email, hd] of [
      ['mohammad.abujoudeh@progineer.net.example', 'progineer.net.example'],
      ['mohammad.abujoudeh@progіneer.net', 'progіneer.net'], // Cyrillic "і"
    ] as const) {
      expect((await googleSignIn(email, hd)).user!.role, email).toBeNull();
    }
    for (const email of [
      `mohammad.abujoudeh2.${crypto.randomUUID().slice(0, 8)}@progineer.net`,
      `mohammad.abujoudeh.${crypto.randomUUID().slice(0, 8)}@stu.najah.edu`,
    ]) {
      expect((await googleSignIn(email, email.split('@')[1]!)).user!.role, email).toBe('Employee');
    }

    // 2. Simultaneous first sign-ins: one account, created once as Admin, recorded as granted by the system rule.
    const first = await Promise.all([1, 2, 3].map(() => googleSignIn(MOHAMMAD, 'progineer.net')));
    expect(first.map((r) => [r.status, r.user!.role])).toEqual([
      [200, 'Admin'],
      [200, 'Admin'],
      [200, 'Admin'],
    ]);
    const [account] = await accounts(MOHAMMAD);
    expect(await accounts(MOHAMMAD)).toEqual([{ id: account!.id, role: 'Admin' }]);
    expect(await audit(account!.id)).toEqual([
      { operation: 'INSERT', actor_type: 'System', actor_id: null, old_role: null, new_role: 'Admin' },
    ]);
    expect((await call('GET', '/api/admin/users', first[0]!.cookie!)).status).toBe(200);

    // 3. Later sign-ins, sign-out, a new browser and an expired session: the saved role, never re-granted.
    const again = await googleSignIn(MOHAMMAD, 'progineer.net');
    expect(again.user!.role).toBe('Admin');
    expect((await call('POST', '/api/auth/sign-out', again.cookie!)).status).toBe(204);
    expect((await call('GET', '/api/auth/me', again.cookie!)).status).toBe(401);
    const afterSignOut = await googleSignIn(MOHAMMAD, 'progineer.net');
    expect(afterSignOut.user!.role).toBe('Admin');
    api.clock.advanceMinutes(7 * 24 * 60);
    try {
      expect((await call('GET', '/api/auth/me', afterSignOut.cookie!)).status).toBe(401); // the session expired
    } finally {
      api.clock.offsetMs = 0;
    }
    expect((await googleSignIn(MOHAMMAD, 'progineer.net')).user!.role).toBe('Admin');
    expect(await audit(account!.id)).toHaveLength(1); // nothing re-applied

    // 4. Another Admin demotes him: the change stands at every later sign-in, until an Admin changes it again.
    const otherAdminEmail = uniqueEmail('stu.najah.edu');
    await googleSignIn(otherAdminEmail, 'stu.najah.edu');
    await setRole(otherAdminEmail, 'Admin');
    const otherAdmin = await googleSignIn(otherAdminEmail, 'stu.najah.edu');
    expect(otherAdmin.user!.role).toBe('Admin'); // the existing Admin is unchanged

    for (const role of ['Employee', 'HR'] as const) {
      expect((await call('PUT', `/api/admin/users/${account!.id}/role`, otherAdmin.cookie!, { role })).status).toBe(
        200,
      );
      expect((await googleSignIn(MOHAMMAD, 'progineer.net')).user!.role).toBe(role);
      expect((await googleSignIn(MOHAMMAD, 'progineer.net')).user!.role).toBe(role);
    }
    const demoted = await googleSignIn(MOHAMMAD, 'progineer.net');
    expect((await call('GET', '/api/admin/users', demoted.cookie!)).status).toBe(403); // HR has no Admin access
    expect(
      (await call('PUT', `/api/admin/users/${account!.id}/role`, otherAdmin.cookie!, { role: 'Admin' })).status,
    ).toBe(200);
    expect((await googleSignIn(MOHAMMAD, 'progineer.net')).user!.role).toBe('Admin');

    const otherAdminId = (otherAdmin.user as { id: string }).id;
    expect(await audit(account!.id)).toEqual([
      { operation: 'INSERT', actor_type: 'System', actor_id: null, old_role: null, new_role: 'Admin' },
      { operation: 'UPDATE', actor_type: 'Staff', actor_id: otherAdminId, old_role: 'Admin', new_role: 'Employee' },
      { operation: 'UPDATE', actor_type: 'Staff', actor_id: otherAdminId, old_role: 'Employee', new_role: 'HR' },
      { operation: 'UPDATE', actor_type: 'Staff', actor_id: otherAdminId, old_role: 'HR', new_role: 'Admin' },
    ]);
  });

  it('every other new staff member of either domain starts as Employee, recorded as created by its verified owner', async () => {
    for (const domain of ['progineer.net', 'stu.najah.edu']) {
      const email = uniqueEmail(domain);
      expect((await googleSignIn(email, domain)).user!.role).toBe('Employee');
      const [account] = await accounts(email);
      expect(await audit(account!.id)).toEqual([
        { operation: 'INSERT', actor_type: 'Staff', actor_id: account!.id, old_role: null, new_role: 'Employee' },
      ]);
    }
  });

  it('simultaneous first sign-ins of a new staff member create one Employee account, and all of them succeed', async () => {
    const email = uniqueEmail('progineer.net');
    const results = await Promise.all([1, 2, 3, 4].map(() => googleSignIn(email, 'progineer.net')));
    expect(results.map((r) => [r.status, r.user!.role])).toEqual(results.map(() => [200, 'Employee']));
    expect((await accounts(email)).map((a) => a.role)).toEqual(['Employee']);
    expect(new Set(results.map((r) => (r.user as { id: string }).id)).size).toBe(1);
  });
});

describe('trainee: passwordless e-mail link or code', () => {
  it('registers and signs in with the e-mailed code', async () => {
    const client = api.client();
    const email = uniqueEmail();

    expect((await client.post('/api/auth/trainee/request', { email })).status).toBe(202);
    const { code } = api.emails.lastSignInFor(email);
    expect(code).toMatch(/^\d{6}$/);
    const message = api.emails.lastTo(email);
    expect(message.subject).toBe(`رمز الدخول / Sign-in code: ${code}`);
    expect(message.textBody).toContain('valid for 15 minutes');
    expect(message.textBody).toContain(`http://localhost:4200/sign-in/verify?token=`);

    const response = await client.post('/api/auth/trainee/verify', { email, code });
    expect(response.status).toBe(200);
    const user = await body(response);
    expect(user).toMatchObject({ role: 'Trainee', email, name: null });
    expect((await body(await client.get('/api/auth/me'))).email).toBe(email);
    const exists = await withDb((db) => db.query('SELECT 1 FROM trainees WHERE email = $1', [email]));
    expect(exists.rowCount).toBe(1);
  });

  it('signs in once with the e-mailed link', async () => {
    const email = uniqueEmail();
    await api.client().post('/api/auth/trainee/request', { email });
    const { token } = api.emails.lastSignInFor(email);

    expect((await api.client().post('/api/auth/trainee/verify', { token })).status).toBe(200);
    const replay = await api.client().post('/api/auth/trainee/verify', { token });
    expect(replay.status).toBe(400);
    expect(await body(replay)).toEqual({
      status: 400,
      detail: 'The sign-in link or code is invalid, expired or already used.',
      code: 'auth.invalid_code',
    });
  });

  it('codes expire after 15 minutes and are valid just before', async () => {
    const email = uniqueEmail();
    const client = api.client();
    await client.post('/api/auth/trainee/request', { email });
    const { code, token } = api.emails.lastSignInFor(email);

    api.clock.advanceMinutes(15);
    try {
      expect((await client.post('/api/auth/trainee/verify', { email, code })).status).toBe(400);
      expect((await client.post('/api/auth/trainee/verify', { token })).status).toBe(400);
    } finally {
      api.clock.advanceMinutes(-15);
    }

    const other = uniqueEmail();
    await client.post('/api/auth/trainee/request', { email: other });
    api.clock.advanceMinutes(14.9);
    try {
      const { code: fresh } = api.emails.lastSignInFor(other);
      expect((await client.post('/api/auth/trainee/verify', { email: other, code: fresh })).status).toBe(200);
    } finally {
      api.clock.advanceMinutes(-14.9);
    }
  });

  it('codes are single use, replaced by newer requests and locked after 5 wrong attempts', async () => {
    const client = api.client();
    const email = uniqueEmail();

    await client.post('/api/auth/trainee/request', { email });
    const first = api.emails.lastSignInFor(email);
    await client.post('/api/auth/trainee/request', { email });
    const second = api.emails.lastSignInFor(email);
    expect((await client.post('/api/auth/trainee/verify', { token: first.token })).status).toBe(400);
    if (first.code !== second.code) {
      expect((await client.post('/api/auth/trainee/verify', { email, code: first.code })).status).toBe(400);
    }

    const wrong = second.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      expect((await client.post('/api/auth/trainee/verify', { email, code: wrong })).status).toBe(400);
    }

    expect((await client.post('/api/auth/trainee/verify', { email, code: second.code })).status).toBe(400);
    const stored = await withDb((db) =>
      db.query(
        'SELECT failed_attempts, superseded_at IS NOT NULL AS superseded FROM trainee_sign_in_codes WHERE email = $1 ORDER BY issued_at',
        [email],
      ),
    );
    expect(stored.rows).toEqual([
      { failed_attempts: 0, superseded: true },
      { failed_attempts: 5, superseded: false },
    ]);
  });

  it('does not reveal whether an account exists and stores only hashes (upper-case hex, as in C#)', async () => {
    const email = uniqueEmail();
    const response = await api.client().post('/api/auth/trainee/request', { email });
    const { code, token } = api.emails.lastSignInFor(email);
    const stored = await withDb((db) => db.query('SELECT * FROM trainee_sign_in_codes WHERE email = $1', [email]));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect((await withDb((db) => db.query('SELECT 1 FROM trainees WHERE email = $1', [email]))).rowCount).toBe(0);
    const row = stored.rows[0];
    expect(row.code_hash).toMatch(/^[0-9A-F]{64}$/);
    expect(row.token_hash).toMatch(/^[0-9A-F]{64}$/);
    expect(row.code_hash).not.toContain(code);
    expect(row.token_hash).not.toBe(token);
    // Same hash formats as the C# API, so a code issued by either API verifies in the other.
    const hex = async (text: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) =>
        b.toString(16).padStart(2, '0'),
      )
        .join('')
        .toUpperCase();
    expect(row.token_hash).toBe(await hex(token));
    expect(row.code_hash).toBe(await hex(`${row.id.replace(/-/g, '')}:${code}`));
  });

  it('normalises the e-mail: case and surrounding white space', async () => {
    const email = uniqueEmail();
    const client = api.client();
    expect((await client.post('/api/auth/trainee/request', { EMAIL: `  ${email.toUpperCase()} ` })).status).toBe(202);
    const { code } = api.emails.lastSignInFor(email);
    expect((await client.post('/api/auth/trainee/verify', { email: email.toUpperCase(), code })).status).toBe(200);
  });

  it('is 503 without an e-mail provider, and stores no code', async () => {
    // The real sender selection: EMAIL_PROVIDER is empty in the test settings.
    const withoutProvider = createTestApi({ emailSender: emailSenderFor });
    const email = uniqueEmail();

    const response = await withoutProvider.client().post('/api/auth/trainee/request', { email });

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await body(response)).toMatchObject({
      status: 503,
      code: 'email.not_configured',
      detail: 'E-mail sending is not configured on the server.',
    });
    const stored = await withDb((db) => db.query('SELECT 1 FROM trainee_sign_in_codes WHERE email = $1', [email]));
    expect(stored.rowCount).toBe(0);
  });

  it('never writes codes to the log outside development', () => {
    const settings = (overrides: Partial<Bindings>) =>
      loadSettings({
        ...(env as unknown as Bindings),
        DATABASE_URL: tlsDatabaseUrl(),
        EMAIL_PROVIDER: 'log',
        ...overrides,
      });
    expect(emailSenderFor(settings({ ENVIRONMENT: 'development' }))).toBe(logEmailSender);
    expect(emailSenderFor(settings({ ENVIRONMENT: 'production' }))).toBe(unconfiguredEmailSender);
  });
});

describe('authorization and isolation', () => {
  it('a trainee sees only their own account and no staff area', async () => {
    const alice = await signInTrainee(api);
    const bob = await signInTrainee(api);

    expect((await body(await alice.client.get('/api/auth/me'))).id).toBe(alice.user.id);
    expect((await body(await bob.client.get('/api/auth/me'))).id).toBe(bob.user.id);
    for (const url of [
      '/api/admin/fields',
      '/api/admin/users',
      '/api/admin/evaluation-criteria',
      '/api/admin/settings/notifications',
    ]) {
      expect((await alice.client.get(url)).status).toBe(403);
    }
  });

  it('signing out ends the session and anonymous requests are refused', async () => {
    const { client } = await signInStaff(api, 'Employee');

    const signOut = await client.post('/api/auth/sign-out');
    expect(signOut.status).toBe(204);
    expect(signOut.headers.get('set-cookie')).toBe(
      'ims.session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; samesite=strict; httponly',
    );
    expect((await client.get('/api/auth/me')).status).toBe(401);
    expect((await client.get('/api/admin/fields')).status).toBe(401);
  });

  it('public sign-in settings expose only the client id, staff domains and lifetime', async () => {
    const response = await api.client().get('/api/auth/config');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await body(response)).toEqual({
      googleClientId: CLIENT_ID,
      googleHostedDomains: [COMPANY_DOMAIN],
      traineeCodeLifetimeMinutes: 15,
    });

    const both = await api.fetch(new Request('http://localhost/api/auth/config'), {
      GOOGLE_HOSTED_DOMAIN: 'stu.najah.edu,progineer.net',
    });
    expect((await body(both)).googleHostedDomains).toEqual(['stu.najah.edu', 'progineer.net']);

    const unconfigured = await api.fetch(new Request('http://localhost/api/auth/config'), { GOOGLE_HOSTED_DOMAIN: '' });
    expect(await body(unconfigured)).toEqual({
      googleClientId: null,
      googleHostedDomains: null,
      traineeCodeLifetimeMinutes: 15,
    });
  });
});

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Strict, path=/, persistent for the 7-day idle timeout, Secure outside development', async () => {
    const email = uniqueEmail();
    const client = api.client();
    await client.post('/api/auth/trainee/request', { email });
    const response = await client.post('/api/auth/trainee/verify', {
      email,
      code: api.emails.lastSignInFor(email).code,
    });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(
      /^ims\.session=v1\.[A-Za-z0-9_-]+; expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT; max-age=604800; path=\/; samesite=strict; httponly$/,
    );
    const expires = Date.parse(/expires=([^;]+)/.exec(cookie)![1]!);
    expect(Math.abs(expires - (api.clock.now().getTime() + 7 * DAY * 60_000))).toBeLessThan(2000);

    // Production: always Secure. (Sign-out does not reach the database, so no TLS database is needed here.)
    const signOut = await api.fetch(new Request('http://localhost/api/auth/sign-out', { method: 'POST' }), {
      ENVIRONMENT: 'production',
      DATABASE_URL: tlsDatabaseUrl(),
    });
    expect(signOut.headers.get('set-cookie')).toBe(
      'ims.session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; secure; samesite=strict; httponly',
    );
  });

  it('production refuses a database URL without sslmode=verify-full', async () => {
    const response = await api.fetch(new Request('http://localhost/api/auth/config'), { ENVIRONMENT: 'production' });
    expect(response.status).toBe(500);
    expect(await body(response)).toMatchObject({
      status: 500,
      title: 'An error occurred while processing your request.',
    });
  });

  it('is renewed hourly while used, so the 7-day idle timeout counts from the last activity', async () => {
    const { client } = await signInTrainee(api);
    try {
      api.clock.advanceMinutes(59);
      expect((await client.get('/api/auth/me')).headers.getSetCookie()).toHaveLength(0);
      api.clock.advanceMinutes(1); // an hour old: re-issued
      const renewed = await client.get('/api/auth/me');
      expect(renewed.status).toBe(200);
      expect(renewed.headers.get('set-cookie')).toMatch(/; max-age=604800; /);

      api.clock.advanceMinutes(7 * DAY - 1); // idle for just under 7 days since that request
      expect((await client.get('/api/auth/me')).status).toBe(200);
      api.clock.advanceMinutes(7 * DAY); // idle for 7 days
      expect((await client.get('/api/auth/me')).status).toBe(401);
    } finally {
      api.clock.offsetMs = 0;
    }
  });

  it.each(['Admin', 'HR', 'Employee', 'Trainee', 'ordinary Google user'] as const)(
    'a %s session still works after a browser restart and inactivity within the idle timeout, and ends exactly at it',
    async (kind) => {
      let client;
      if (kind === 'Trainee') ({ client } = await signInTrainee(api));
      else if (kind !== 'ordinary Google user') ({ client } = await signInStaff(api, kind));
      else {
        client = api.client();
        await client.post('/api/auth/staff/google', {
          idToken: await api.google.issue(uniqueEmail('gmail.com'), null),
        });
      }

      // A reopened browser that kept the cookie: a new request carrying only that cookie, nothing else.
      const cookie = client.cookies.get('ims.session')!;
      const reopen = () =>
        api.fetch(new Request('http://localhost/api/auth/me', { headers: { cookie: `ims.session=${cookie}` } }));
      try {
        api.clock.offsetMs = (7 * DAY * 60 - 1) * 1000; // browser closed for 6 days 23 h 59 min 59 s
        expect((await reopen()).status).toBe(200);
        api.clock.offsetMs = 7 * DAY * 60_000;
        expect((await reopen()).status).toBe(401);
      } finally {
        api.clock.offsetMs = 0;
      }
    },
  );

  it('cannot be read or forged by the client', async () => {
    const { client } = await signInTrainee(api);
    const value = client.cookies.get('ims.session')!;
    const payload = value.slice(3);
    const tampered = `v1.${payload.slice(0, -2)}${payload.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const cookie of [tampered, 'v1.', 'garbage', `v2.${payload}`]) {
      const response = await api.fetch(
        new Request('http://localhost/api/auth/me', { headers: { cookie: `ims.session=${cookie}` } }),
      );
      expect(response.status, cookie).toBe(401);
    }

    // Signed with another secret: rejected; accepted while that secret is SESSION_SECRET_PREVIOUS (key rotation).
    const rotated = { SESSION_SECRET: 'another-session-secret-0123456789abcdef0123' };
    const request = () => new Request('http://localhost/api/auth/me', { headers: { cookie: `ims.session=${value}` } });
    expect((await api.fetch(request(), rotated)).status).toBe(401);
    const previous = { ...rotated, SESSION_SECRET_PREVIOUS: TEST_SESSION_SECRET };
    expect((await api.fetch(request(), previous)).status).toBe(200);
  });

  it('of an account that no longer exists is cleared', async () => {
    // Accounts are never deleted (database triggers), so use a valid cookie for an id that has no account.
    const ghost = await protectTicket(
      newTicket(
        { id: crypto.randomUUID(), role: 'Trainee', email: 'x@uni.example', name: null },
        { id: crypto.randomUUID(), expiresAt: new Date(api.clock.now().getTime() + 30 * DAY * 60_000) },
        api.clock.now(),
        7 * DAY,
      ),
      TEST_SESSION_SECRET,
    );
    const response = await api.fetch(
      new Request('http://localhost/api/auth/me', { headers: { cookie: `ims.session=${ghost}` } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBe(
      'ims.session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; samesite=strict; httponly',
    );
  });

  it('needs a SESSION_SECRET of at least 32 characters', async () => {
    const response = await api.fetch(new Request('http://localhost/api/auth/config'), {
      SESSION_SECRET: 'too-short-secret',
    });
    expect(response.status).toBe(500);
  });
});

describe('server-side sessions (AD-44)', () => {
  type Kind = 'Admin' | 'HR' | 'Employee' | 'Trainee' | 'ordinary Google user';
  const KINDS: Kind[] = ['Admin', 'HR', 'Employee', 'Trainee', 'ordinary Google user'];

  async function signInAs(kind: Kind) {
    if (kind === 'Trainee') return (await signInTrainee(api)).client;
    if (kind !== 'ordinary Google user') return (await signInStaff(api, kind)).client;
    const client = api.client();
    const subject = String(Math.floor(Math.random() * 1e15));
    await client.post('/api/auth/staff/google', {
      idToken: await api.google.issue(uniqueEmail('gmail.com'), null, { claims: { sub: subject } }),
    });
    return client;
  }

  /** A request from another browser holding a copy of `cookie`. */
  const withCookie = (cookie: string, path = '/api/auth/me') =>
    api.fetch(new Request(`http://localhost${path}`, { headers: { cookie: `ims.session=${cookie}` } }));

  const sessionOf = async (cookie: string) => {
    const ticket = (await unprotectTicket(cookie, [TEST_SESSION_SECRET], api.clock.now()))!;
    const { rows } = await withDb((db) =>
      db.query<{ created_at: Date; expires_at: Date; revoked_at: Date | null; revoke_reason: string | null }>(
        'SELECT created_at, expires_at, revoked_at, revoke_reason FROM user_sessions WHERE id = $1',
        [ticket.sid],
      ),
    );
    return { ticket, row: rows[0]! };
  };

  it.each(KINDS)('a %s sign-in creates a session that ends 30 days later at the latest', async (kind) => {
    const client = await signInAs(kind);
    const { ticket, row } = await sessionOf(client.cookies.get('ims.session')!);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(30 * DAY * 60_000);
    expect(ticket.aexp).toBe(row.expires_at.getTime());
    expect(row.revoked_at).toBeNull();
  });

  it.each(KINDS)('activity never extends a %s session beyond 30 days after sign-in', async (kind) => {
    const client = await signInAs(kind);
    try {
      for (let day = 6; day <= 18; day += 6) {
        api.clock.offsetMs = day * DAY * 60_000;
        expect((await client.get('/api/auth/me')).status, `day ${day}`).toBe(200);
      }

      // Renewed on day 24, the cookie gets only the 6 days left, not 7, and is not extended after that.
      api.clock.offsetMs = 24 * DAY * 60_000;
      const capped = await client.get('/api/auth/me');
      const maxAge = Number(/max-age=(\d+)/.exec(capped.headers.get('set-cookie')!)![1]);
      expect(Math.abs(maxAge - 6 * DAY * 60)).toBeLessThan(5);
      api.clock.offsetMs = 29 * DAY * 60_000;
      const late = await client.get('/api/auth/me');
      expect(late.status).toBe(200);
      expect(late.headers.getSetCookie()).toHaveLength(0);

      api.clock.offsetMs = 30 * DAY * 60_000 - 1000;
      expect((await client.get('/api/auth/me')).status).toBe(200);
      api.clock.offsetMs = 30 * DAY * 60_000;
      expect((await client.get('/api/auth/me')).status).toBe(401);
    } finally {
      api.clock.offsetMs = 0;
    }
  });

  it.each(KINDS)('signing out revokes a %s session server-side: a copy of the cookie is refused', async (kind) => {
    const client = await signInAs(kind);
    const copy = client.cookies.get('ims.session')!;

    expect((await client.post('/api/auth/sign-out')).status).toBe(204);

    const replay = await withCookie(copy);
    expect(replay.status).toBe(401);
    expect(replay.headers.get('set-cookie')).toMatch(/^ims\.session=; expires=Thu, 01 Jan 1970/);
    expect((await withCookie(copy, '/api/admin/fields')).status).toBe(401);
    const { row } = await sessionOf(copy);
    expect(row.revoke_reason).toBe('SignOut');
    expect(row.revoked_at).not.toBeNull();
  });

  it('sessions are independent: signing out on one device keeps the others signed in', async () => {
    const { client: laptop, email } = await signInStaff(api, 'Admin');
    const phone = api.client();
    await phone.post('/api/auth/staff/google', { idToken: await api.google.issue(email, COMPANY_DOMAIN) });
    expect(laptop.cookies.get('ims.session')).not.toBe(phone.cookies.get('ims.session'));

    const [a, b] = await Promise.all([laptop.get('/api/auth/me'), phone.get('/api/auth/me')]);
    expect([a.status, b.status]).toEqual([200, 200]);

    await phone.post('/api/auth/sign-out');
    expect((await phone.get('/api/auth/me')).status).toBe(401);
    expect((await laptop.get('/api/auth/me')).status).toBe(200);
    expect((await laptop.get('/api/admin/fields')).status).toBe(200);
  });

  it('signing out twice, or with a revoked or no session, is harmless', async () => {
    const client = await signInAs('Employee');
    const copy = client.cookies.get('ims.session')!;
    await client.post('/api/auth/sign-out');
    const again = await api.fetch(
      new Request('http://localhost/api/auth/sign-out', { method: 'POST', headers: { cookie: `ims.session=${copy}` } }),
    );
    expect(again.status).toBe(204);
    expect((await api.client().post('/api/auth/sign-out')).status).toBe(204);
    const { row } = await sessionOf(copy);
    expect(row.revoke_reason).toBe('SignOut');
  });

  it("a cookie naming another user's session is refused", async () => {
    const alice = await signInAs('Employee');
    const bob = await signInStaff(api, 'Employee');
    const aliceTicket = (await sessionOf(alice.cookies.get('ims.session')!)).ticket;
    const forged = await protectTicket({ ...aliceTicket, sub: bob.user.id }, TEST_SESSION_SECRET);
    expect((await withCookie(forged)).status).toBe(401);
  });

  it('records the session start as the user who signed in, and the sign-out as the signed-in user', async () => {
    const { client, user } = await signInStaff(api, 'Employee');
    const { ticket } = await sessionOf(client.cookies.get('ims.session')!);
    await client.post('/api/auth/sign-out');
    const audit = await withDb((db) =>
      db.query(
        `SELECT operation, actor_type, actor_id FROM audit_logs
          WHERE table_name = 'user_sessions' AND entity_id = $1 ORDER BY id`,
        [ticket.sid],
      ),
    );
    expect(audit.rows).toEqual([
      { operation: 'INSERT', actor_type: 'Staff', actor_id: user.id },
      { operation: 'UPDATE', actor_type: 'Staff', actor_id: user.id },
    ]);
  });

  describe('a new sign-in in the same browser', () => {
    /** A browser and a way to sign it in (again) as one account of `kind`, through that account's real flow. */
    function account(kind: Kind) {
      const client = api.client();
      if (kind === 'Trainee') {
        const email = uniqueEmail();
        return {
          client,
          signIn: async (browser: TestClient) => {
            await browser.post('/api/auth/trainee/request', { email });
            return browser.post('/api/auth/trainee/verify', { email, code: api.emails.lastSignInFor(email).code });
          },
        };
      }

      const google = kind === 'ordinary Google user';
      const email = uniqueEmail(google ? 'gmail.com' : COMPANY_DOMAIN);
      const sub = String(Math.floor(Math.random() * 1e15));
      let first = true;
      return {
        client,
        signIn: async (browser: TestClient) => {
          const response = await browser.post('/api/auth/staff/google', {
            idToken: await api.google.issue(email, google ? null : COMPANY_DOMAIN, { claims: { sub } }),
          });
          if (first && (kind === 'Admin' || kind === 'HR')) await setRole(email, kind);
          first = false;
          return response;
        },
      };
    }

    it.each(KINDS)('revokes the %s session it replaces; the new session works', async (kind) => {
      const { client, signIn } = account(kind);
      expect((await signIn(client)).status).toBe(200);
      const old = client.cookies.get('ims.session')!;

      expect((await signIn(client)).status).toBe(200);
      const current = client.cookies.get('ims.session')!;
      expect(current).not.toBe(old);

      expect((await withCookie(old)).status).toBe(401);
      expect((await withCookie(current)).status).toBe(200);
      expect((await sessionOf(old)).row.revoke_reason).toBe('Replaced');
      expect((await sessionOf(current)).row.revoked_at).toBeNull();
    });

    it('also when a different account signs in from that browser', async () => {
      const { client } = await signInStaff(api, 'Employee');
      const old = client.cookies.get('ims.session')!;
      const email = uniqueEmail();
      await client.post('/api/auth/trainee/request', { email });
      const trainee = await client.post('/api/auth/trainee/verify', {
        email,
        code: api.emails.lastSignInFor(email).code,
      });

      expect((await body(trainee)).role).toBe('Trainee');
      expect((await sessionOf(old)).row.revoke_reason).toBe('Replaced');
    });

    it('a failed or incomplete sign-in revokes nothing', async () => {
      const { client, email } = await signInStaff(api, 'Admin');
      const session = client.cookies.get('ims.session')!;
      const traineeEmail = uniqueEmail();

      const attempts = [
        await client.post('/api/auth/staff/google', { idToken: 'not-a-token' }),
        await client.post('/api/auth/staff/google', {
          idToken: await api.google.issue(email, COMPANY_DOMAIN, { emailVerified: false }),
        }),
        await client.post('/api/auth/staff/google', {}),
        await client.post('/api/auth/trainee/request', { email: traineeEmail }), // a code is sent: not signed in yet
        await client.post('/api/auth/trainee/verify', { email: traineeEmail, code: '000000' }),
        await client.post('/api/auth/trainee/verify', { token: 'f'.repeat(64) }),
      ];
      expect(attempts.map((r) => r.status)).toEqual([401, 401, 400, 202, 400, 400]);

      // Still the same session (the cookie itself may be re-issued with the Admin role granted after sign-in).
      const { ticket } = await sessionOf(client.cookies.get('ims.session')!);
      expect(ticket.sid).toBe((await sessionOf(session)).ticket.sid);
      expect((await client.get('/api/admin/fields')).status).toBe(200);
      expect((await sessionOf(session)).row.revoked_at).toBeNull();
    });

    it('if the new session cannot be stored, the previous one stays active (one transaction)', async () => {
      const { client } = await signInStaff(api, 'Employee');
      const session = client.cookies.get('ims.session')!;

      // A Google subject longer than the column allows: the INSERT fails after the revocation in the same transaction.
      const failed = await client.post('/api/auth/staff/google', {
        idToken: await api.google.issue(uniqueEmail('gmail.com'), null, { claims: { sub: '1'.repeat(300) } }),
      });
      expect(failed.status).toBe(500);

      expect(client.cookies.get('ims.session')).toBe(session);
      expect((await client.get('/api/auth/me')).status).toBe(200);
      expect((await sessionOf(session)).row.revoked_at).toBeNull();
    });

    it('a cookie that is no longer valid is not revoked again', async () => {
      const { client, signIn } = account('Employee');
      await signIn(client);
      const signedOut = client.cookies.get('ims.session')!;
      await client.post('/api/auth/sign-out');

      // The browser still sends the old cookie with its next sign-in: it is ignored, keeping its SignOut reason.
      client.cookies.set('ims.session', signedOut);
      expect((await signIn(client)).status).toBe(200);
      expect((await sessionOf(signedOut)).row.revoke_reason).toBe('SignOut');
    });

    it('leaves the sessions of other browsers and devices alone', async () => {
      const { client: laptop, signIn } = account('Employee');
      await signIn(laptop);
      const phone = api.client();
      await signIn(phone);
      const phoneBefore = phone.cookies.get('ims.session')!;

      await signIn(phone); // the phone signs in again: only its own previous session is replaced
      await signIn(api.client()); // a new device: replaces nothing

      expect((await laptop.get('/api/auth/me')).status).toBe(200);
      expect((await phone.get('/api/auth/me')).status).toBe(200);
      expect((await sessionOf(laptop.cookies.get('ims.session')!)).row.revoked_at).toBeNull();
      expect((await sessionOf(phoneBefore)).row.revoke_reason).toBe('Replaced');
    });

    it('records the revocation and the new session in one transaction, as the signed-in user', async () => {
      const { client, user, email } = await signInStaff(api, 'Employee');
      const old = (await sessionOf(client.cookies.get('ims.session')!)).ticket.sid!;
      await client.post('/api/auth/staff/google', { idToken: await api.google.issue(email, COMPANY_DOMAIN) });
      const current = (await sessionOf(client.cookies.get('ims.session')!)).ticket.sid!;

      const audit = await withDb((db) =>
        db.query<{ entity_id: string; transaction_id: string }>(
          `SELECT entity_id, operation, actor_type, actor_id, transaction_id::text,
                  new_values->>'revoke_reason' AS reason
             FROM audit_logs WHERE table_name = 'user_sessions' AND entity_id = ANY($1) ORDER BY id`,
          [[old, current]],
        ),
      );
      const rows = audit.rows.map(({ transaction_id: _, ...row }) => row);
      expect(rows[0]).toEqual({
        entity_id: old,
        operation: 'INSERT',
        actor_type: 'Staff',
        actor_id: user.id,
        reason: null,
      });
      // The revocation and the new session come from one statement (one transaction), so their order is not fixed.
      expect(rows.slice(1)).toEqual(
        expect.arrayContaining([
          { entity_id: old, operation: 'UPDATE', actor_type: 'Staff', actor_id: user.id, reason: 'Replaced' },
          { entity_id: current, operation: 'INSERT', actor_type: 'Staff', actor_id: user.id, reason: null },
        ]),
      );
      expect(rows).toHaveLength(3);
      expect(audit.rows[1]!.transaction_id).toBe(audit.rows[2]!.transaction_id);
    });

    it('two simultaneous sign-ins from the same browser revoke its session once, and both succeed', async () => {
      const { client, email } = await signInStaff(api, 'Employee');
      const old = client.cookies.get('ims.session')!;
      const signIn = async () =>
        api.fetch(
          new Request('http://localhost/api/auth/staff/google', {
            method: 'POST',
            headers: { cookie: `ims.session=${old}`, 'content-type': 'application/json' },
            body: JSON.stringify({ idToken: await api.google.issue(email, COMPANY_DOMAIN) }),
          }),
        );

      const responses = await Promise.all([signIn(), signIn()]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const { ticket, row } = await sessionOf(old);
      expect(row.revoke_reason).toBe('Replaced');
      const updates = await withDb((db) =>
        db.query(
          "SELECT 1 FROM audit_logs WHERE table_name = 'user_sessions' AND entity_id = $1 AND operation = 'UPDATE'",
          [ticket.sid],
        ),
      );
      expect(updates.rowCount).toBe(1);
    });
  });

  describe('session writes are single statements', () => {
    /** The Worker's Database, recording every statement it sends (one statement = one round trip). */
    class RecordingDatabase extends Database {
      readonly statements: string[] = [];
      override query: Database['query'] = (text, params) => {
        this.statements.push(text);
        return super.query(text, params);
      };
      override transaction: Database['transaction'] = () => {
        throw new Error('session writes must not open a multi-statement transaction');
      };
    }

    const databaseUrl = () => (env as unknown as Bindings).DATABASE_URL!;
    const auditOf = (sessionId: string) =>
      withDb((db) =>
        db.query<{ operation: string; actor_type: string; actor_id: string | null; reason: string | null; tx: string }>(
          `SELECT operation, actor_type, actor_id, new_values->>'revoke_reason' AS reason, transaction_id::text AS tx
             FROM audit_logs WHERE table_name = 'user_sessions' AND entity_id = $1 ORDER BY id`,
          [sessionId],
        ),
      ).then((r) => r.rows);

    it('start, replace and revoke each send one statement, audited as the actor, without leaking the actor', async () => {
      const { user } = await signInTrainee(api);
      const actor: AuditActor = { type: 'Trainee', id: user.id };
      const trainee = { id: user.id, role: 'Trainee' as const, email: user.email, name: null };
      const db = new RecordingDatabase(databaseUrl());
      try {
        const first = await startSession(db, actor, trainee, api.clock.now(), 30 * DAY);
        const second = await startSession(db, actor, trainee, api.clock.now(), 30 * DAY, first.id);
        await revokeSession(db, actor, second.id, api.clock.now());
        expect(db.statements).toHaveLength(3);

        // The actor was transaction-scoped: the same connection has none afterwards.
        const { rows } = await db.query<{ type: string | null; id: string | null }>(
          "SELECT current_setting('ims.actor_type', true) AS type, current_setting('ims.actor_id', true) AS id",
        );
        expect([rows[0]!.type ?? '', rows[0]!.id ?? '']).toEqual(['', '']);

        const [created, replaced] = await Promise.all([auditOf(first.id), auditOf(second.id)]);
        expect(created.map(({ tx: _, ...row }) => row)).toEqual([
          { operation: 'INSERT', actor_type: 'Trainee', actor_id: user.id, reason: null },
          { operation: 'UPDATE', actor_type: 'Trainee', actor_id: user.id, reason: 'Replaced' },
        ]);
        expect(replaced.map(({ tx: _, ...row }) => row)).toEqual([
          { operation: 'INSERT', actor_type: 'Trainee', actor_id: user.id, reason: null },
          { operation: 'UPDATE', actor_type: 'Trainee', actor_id: user.id, reason: 'SignOut' },
        ]);
        expect(created[1]!.tx).toBe(replaced[0]!.tx); // replacement and new session: one transaction
      } finally {
        await db.close();
      }
    });

    it('an anonymous sign-in leaves no actor behind for a later write on the same connection', async () => {
      const { user } = await signInTrainee(api);
      const db = new RecordingDatabase(databaseUrl());
      try {
        const trainee = { id: user.id, role: 'Trainee' as const, email: user.email, name: null };
        const session = await startSession(db, { type: 'Staff', id: user.id }, trainee, api.clock.now(), 30 * DAY);
        // A later write on the same connection that sets no actor is recorded by the trigger as the database itself.
        await db.query("UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'SignOut' WHERE id = $1", [
          session.id,
        ]);
        const audit = await auditOf(session.id);
        expect(audit.map((row) => row.actor_type)).toEqual(['Staff', 'Database']);
      } finally {
        await db.close();
      }
    });

    it('revoking an unknown or already revoked session changes nothing and writes no audit row', async () => {
      const client = await signInAs('Employee');
      const { ticket } = await sessionOf(client.cookies.get('ims.session')!);
      await client.post('/api/auth/sign-out');
      const db = new Database(databaseUrl());
      try {
        await revokeSession(db, { type: 'System', id: null }, ticket.sid!, api.clock.now());
        await revokeSession(db, { type: 'System', id: null }, crypto.randomUUID(), api.clock.now());
      } finally {
        await db.close();
      }

      const audit = await auditOf(ticket.sid!);
      expect(audit.map((row) => [row.operation, row.reason])).toEqual([
        ['INSERT', null],
        ['UPDATE', 'SignOut'],
      ]);
    });

    it('simultaneous sign-outs with the same cookie revoke the session once', async () => {
      const client = await signInAs('Trainee');
      const cookie = client.cookies.get('ims.session')!;
      const signOut = () =>
        api.fetch(
          new Request('http://localhost/api/auth/sign-out', {
            method: 'POST',
            headers: { cookie: `ims.session=${cookie}` },
          }),
        );

      const responses = await Promise.all([signOut(), signOut(), signOut()]);
      expect(responses.map((r) => r.status)).toEqual([204, 204, 204]);
      const { ticket } = await sessionOf(cookie);
      expect((await auditOf(ticket.sid!)).filter((row) => row.operation === 'UPDATE')).toHaveLength(1);
      expect((await withCookie(cookie)).status).toBe(401);
    });

    it('a sign-out racing a sign-in that replaces the same session: revoked exactly once, the new session works', async () => {
      const { client, email } = await signInStaff(api, 'Employee');
      const old = client.cookies.get('ims.session')!;
      const withOld = (path: string, body?: unknown) =>
        api.fetch(
          new Request(`http://localhost${path}`, {
            method: 'POST',
            headers: { cookie: `ims.session=${old}`, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );

      const [signOut, signIn] = await Promise.all([
        withOld('/api/auth/sign-out'),
        withOld('/api/auth/staff/google', { idToken: await api.google.issue(email, COMPANY_DOMAIN) }),
      ]);
      expect([signOut.status, signIn.status]).toEqual([204, 200]);

      const { ticket, row } = await sessionOf(old);
      expect(['SignOut', 'Replaced']).toContain(row.revoke_reason);
      expect((await auditOf(ticket.sid!)).filter((r) => r.operation === 'UPDATE')).toHaveLength(1);
      const fresh = /^ims\.session=([^;]+)/.exec(signIn.headers.get('set-cookie')!)![1]!;
      expect((await withCookie(fresh)).status).toBe(200);
    });
  });

  describe('a session cookie issued before AD-44 (no session row)', () => {
    const legacy = async (user: { id: string; role: 'Trainee' | 'Employee' }, minutesOld: number) => {
      const iat = api.clock.now().getTime() - minutesOld * 60_000;
      return protectTicket({ sub: user.id, role: user.role, iat, exp: iat + 480 * 60_000 }, TEST_SESSION_SECRET);
    };

    it('stays signed in: it is moved to a new 30-day session, which sign-out then revokes', async () => {
      const { user } = await signInTrainee(api);
      const old = await legacy({ id: user.id, role: 'Trainee' }, 300);

      const upgraded = await withCookie(old);
      expect(upgraded.status).toBe(200);
      const cookie = /^ims\.session=([^;]+); expires=[^;]+; max-age=604800;/.exec(
        upgraded.headers.get('set-cookie')!,
      )![1]!;
      const { row } = await sessionOf(cookie);
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(30 * DAY * 60_000);

      expect((await withCookie(cookie)).status).toBe(200);
      const signOut = await api.fetch(
        new Request('http://localhost/api/auth/sign-out', {
          method: 'POST',
          headers: { cookie: `ims.session=${cookie}` },
        }),
      );
      expect(signOut.status).toBe(204);
      expect((await withCookie(cookie)).status).toBe(401);
    });

    it('is refused once its own 8 hours have passed', async () => {
      const { user } = await signInTrainee(api);
      expect((await withCookie(await legacy({ id: user.id, role: 'Trainee' }, 480))).status).toBe(401);
    });
  });

  it('the absolute lifetime cannot be shorter than the idle timeout', () => {
    const settings = (overrides: Partial<Bindings>) => () => loadSettings({ ...(env as Bindings), ...overrides });
    expect(settings({})().sessionIdleTimeoutMinutes).toBe(7 * DAY);
    expect(settings({})().sessionAbsoluteLifetimeMinutes).toBe(30 * DAY);
    expect(settings({ SESSION_IDLE_TIMEOUT_MINUTES: '2', SESSION_ABSOLUTE_LIFETIME_MINUTES: '5' })()).toMatchObject({
      sessionIdleTimeoutMinutes: 2,
      sessionAbsoluteLifetimeMinutes: 5,
    });
    expect(settings({ SESSION_IDLE_TIMEOUT_MINUTES: '60', SESSION_ABSOLUTE_LIFETIME_MINUTES: '30' })).toThrow(
      /must not be shorter/,
    );
  });
});

describe('audit actor', () => {
  it('records the code request as Anonymous, and its verified use and the new account as the trainee', async () => {
    const { user, email } = await signInTrainee(api);
    const audit = await withDb((db) =>
      db.query(
        `SELECT table_name, operation, actor_type, actor_id, array(SELECT jsonb_object_keys(new_values) ORDER BY 1) AS columns
           FROM audit_logs
          WHERE entity_id = $1 OR entity_id IN (SELECT id::text FROM trainee_sign_in_codes WHERE email = $2)
          ORDER BY id`,
        [user.id, email],
      ),
    );
    expect(audit.rows).toEqual([
      {
        table_name: 'trainee_sign_in_codes',
        operation: 'INSERT',
        actor_type: 'Anonymous',
        actor_id: null,
        columns: [
          'code_hash',
          'email',
          'expires_at',
          'failed_attempts',
          'id',
          'issued_at',
          'superseded_at',
          'token_hash',
          'used_at',
        ],
      },
      {
        table_name: 'trainee_sign_in_codes',
        operation: 'UPDATE',
        actor_type: 'Trainee',
        actor_id: user.id,
        columns: ['used_at'],
      },
      {
        table_name: 'trainees',
        operation: 'INSERT',
        actor_type: 'Trainee',
        actor_id: user.id,
        // The profile columns (PDF §8) exist from the start and are filled in by the first application.
        columns: ['email', 'full_name', 'id', 'major', 'phone', 'study_year', 'university'],
      },
    ]);
  });

  it('records a signed-in user as the actor', async () => {
    const admin = await signInStaff(api, 'Admin');
    const created = await body(
      await admin.client.post('/api/admin/fields', { name: `Audit ${crypto.randomUUID().slice(0, 8)}` }),
    );
    const audit = await withDb((db) =>
      db.query('SELECT actor_type, actor_id FROM audit_logs WHERE entity_id = $1', [created.id]),
    );
    expect(audit.rows).toEqual([{ actor_type: 'Staff', actor_id: admin.user.id }]);
  });
});
