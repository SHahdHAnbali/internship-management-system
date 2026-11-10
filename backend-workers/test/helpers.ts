import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import pg from 'pg';
import { createApp, productionDependencies } from '../src/app';
import { createGoogleVerifier } from '../src/auth/google';
import type { Bindings } from '../src/config';
import type { Dependencies } from '../src/context';
import type { EmailMessage, EmailSender } from '../src/email';

/** Test doubles for the external services (the C# tests' FakeGoogleIdTokenValidator, CapturingEmailSender, TestClock). */
export const COMPANY_DOMAIN = 'company.example';
export const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

export class TestClock {
  offsetMs = 0;
  now = (): Date => new Date(Date.now() + this.offsetMs);
  advanceMinutes(minutes: number) {
    this.offsetMs += minutes * 60_000;
  }
}

export class CapturingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage) {
    this.sent.push(message);
  }

  lastTo(to: string): EmailMessage {
    const message = this.sent.findLast((m) => m.to === to);
    if (!message) throw new Error(`No e-mail was sent to ${to}.`);
    return message;
  }

  lastSignInFor(to: string): { code: string; token: string } {
    const body = this.lastTo(to).textBody;
    return { code: /code: (\d{6})/.exec(body)![1]!, token: /verify\?token=([A-Za-z0-9_-]+)/.exec(body)![1]! };
  }
}

/**
 * Issues Google-style ID tokens signed with a test RSA key. The API verifies them with the real verifier (signature,
 * issuer, audience, expiry) against this key instead of Google's published keys.
 */
export class TestGoogle {
  readonly #keys = crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;

  readonly kid = 'test-key-1';

  async publicJwks(): Promise<JsonWebKey[]> {
    const jwk = (await crypto.subtle.exportKey('jwk', (await this.#keys).publicKey)) as JsonWebKey;
    return [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' } as JsonWebKey];
  }

  async issue(
    email: string,
    hostedDomain: string | null,
    options: {
      emailVerified?: boolean;
      name?: string | null;
      claims?: Record<string, unknown>;
      header?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: crypto.randomUUID(),
      email,
      email_verified: options.emailVerified ?? true,
      name: options.name === undefined ? 'Test User' : options.name,
      iat: now,
      exp: now + 3600,
      ...(hostedDomain ? { hd: hostedDomain } : {}),
      ...options.claims,
    };
    return this.sign(payload, { alg: 'RS256', kid: this.kid, typ: 'JWT', ...options.header });
  }

  async sign(payload: Record<string, unknown>, header: Record<string, unknown>): Promise<string> {
    const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      (await this.#keys).privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface TestApi {
  clock: TestClock;
  emails: CapturingEmailSender;
  google: TestGoogle;
  /** A new HTTP client with its own cookie jar and client IP (for the rate limiter). */
  client(options?: { ip?: string }): TestClient;
  /** Calls the Worker with a raw request (no cookie handling). */
  fetch(request: Request, bindings?: Partial<Bindings>): Promise<Response>;
}

/** `bindings` override the test configuration for every request of this API (for example EVENT_EMAILS). */
export function createTestApi(overrides: Partial<Dependencies> = {}, bindings: Partial<Bindings> = {}): TestApi {
  const clock = new TestClock();
  const emails = new CapturingEmailSender();
  const google = new TestGoogle();
  const app = createApp({
    now: clock.now,
    google: createGoogleVerifier(
      () => google.publicJwks(),
      () => undefined,
    ),
    emailSender: () => emails,
    rateLimit: productionDependencies.rateLimit, // the real Workers Rate Limiting binding (Miniflare)
    ...overrides,
  });

  const fetch = async (request: Request, extra: Partial<Bindings> = {}) => {
    const ctx = createExecutionContext();
    const response = await app.fetch(request, { ...env, ...bindings, ...extra }, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };

  return { clock, emails, google, fetch, client: (options) => new TestClient(fetch, options?.ip ?? randomIp()) };
}

function randomIp(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
}

/** A browser-like client: keeps the session cookie from Set-Cookie and sends it back. */
export class TestClient {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly send: (request: Request) => Promise<Response>,
    readonly ip: string,
  ) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = { method, headers: { 'cf-connecting-ip': this.ip, ...headers } };
    if (body instanceof FormData) {
      init.body = body; // multipart: the runtime sets the content type with its boundary
    } else if (body !== undefined) {
      init.body =
        typeof body === 'string' || body instanceof Blob || body instanceof Uint8Array ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
    }

    if (this.cookies.size > 0) {
      (init.headers as Record<string, string>).cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const response = await this.send(new Request(`http://localhost${path}`, init));
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    return response;
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body);
  put = (path: string, body?: unknown) => this.request('PUT', path, body);
}

/** Runs SQL directly against the test database as its owner (assertions and seeding, outside the API). */
export async function withDb<T>(work: (db: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ownerDatabaseUrl() });
  client.on('error', () => undefined); // pg-cloudflare reports its socket shutdown after end()
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** The schema owner's URL (the Worker itself connects as `ims_app`, see test/global-setup.ts). */
export function ownerDatabaseUrl(): string {
  return (env as unknown as { OWNER_DATABASE_URL: string }).OWNER_DATABASE_URL;
}

/** Seeds a staff account as the C# tests do (actor System), returning its id. */
export async function seedEmployee(email = `${crypto.randomUUID().replace(/-/g, '')}@company.com`, role = 'Employee') {
  const id = crypto.randomUUID();
  await withDb(async (db) => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('ims.actor_type', 'System', true)");
    await db.query('INSERT INTO employees (id, full_name, email, department, role) VALUES ($1, $2, $3, NULL, $4)', [
      id,
      'New Employee',
      email,
      role,
    ]);
    await db.query('COMMIT');
  });
  return { id, email };
}

/** Stands in for the operator's one-time SQL step (first Admin, PDF Q17). */
export async function setRole(email: string, role: string) {
  await withDb((db) => db.query('UPDATE employees SET role = $1 WHERE email = $2', [role, email.toLowerCase()]));
}

/**
 * A staff client signed in through the real Google flow (first sign-in creates an Employee); other roles are then
 * granted directly in the database, the documented first-Admin step. There is no authentication bypass.
 */
export async function signInStaff(
  api: TestApi,
  role: 'Admin' | 'HR' | 'Employee',
  email = uniqueEmail(COMPANY_DOMAIN),
) {
  const client = api.client();
  const response = await client.post('/api/auth/staff/google', {
    idToken: await api.google.issue(email, COMPANY_DOMAIN),
  });
  if (response.status !== 200)
    throw new Error(`Staff sign-in failed with ${response.status}: ${await response.text()}`);
  const user = await body<{ id: string; role: string; email: string }>(response);
  if (role !== 'Employee') await setRole(email, role);
  return { client, user: { ...user, role }, email };
}

/** A trainee client signed in through the e-mailed code. */
export async function signInTrainee(api: TestApi, email = uniqueEmail()) {
  const client = api.client();
  await client.post('/api/auth/trainee/request', { email });
  const { code } = api.emails.lastSignInFor(email);
  const response = await client.post('/api/auth/trainee/verify', { email, code });
  if (response.status !== 200)
    throw new Error(`Trainee sign-in failed with ${response.status}: ${await response.text()}`);
  return { client, user: await body<{ id: string; role: string; email: string }>(response), email };
}

export function unique(prefix: string): string {
  return `${prefix} ${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export function uniqueEmail(domain = 'uni.example'): string {
  return `${crypto.randomUUID().replace(/-/g, '')}@${domain}`;
}

export async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
