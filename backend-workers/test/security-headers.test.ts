import { describe, expect, it } from 'vitest';
import { body, COMPANY_DOMAIN, createTestApi, signInStaff, signInTrainee, uniqueEmail } from './helpers';
import { newField, submitApplication } from './seed';
import { RATE_LIMIT_PERIOD_SECONDS } from '../src/app';
// The Cloudflare configuration as text (Vite `?raw`), to compare it with the Worker's constant.
import wranglerConfig from '../wrangler.jsonc?raw';

/**
 * Response headers of the API (security assessment of 2026-11-04, B1 and B3). Every response that does not set its own
 * caching policy is `no-store`, and every response is `nosniff`; the responses with their own policy (files, images,
 * cookies, errors, health) keep it. A rate-limited request says when to retry. The HTML-only headers (CSP, frame and
 * referrer policies) belong to the static site (`frontend/public/_headers`), not to API responses.
 */
const api = createTestApi();

const headersOf = (response: Response) => ({
  cacheControl: response.headers.get('cache-control'),
  nosniff: response.headers.get('x-content-type-options'),
});
const STORE_NOTHING = { cacheControl: 'no-store', nosniff: 'nosniff' };

describe('API responses are never stored and never sniffed', () => {
  it('anonymous: a public JSON response, a 401 problem and an unknown path', async () => {
    const client = api.client();
    expect(headersOf(await client.get('/api/auth/config'))).toEqual(STORE_NOTHING);
    expect(headersOf(await client.get('/api/auth/me'))).toEqual(STORE_NOTHING);
    expect(headersOf(await client.get('/api/no-such-endpoint'))).toEqual(STORE_NOTHING);
  });

  it('signed in: personal data, 415, 400, 403, 404 and 405 responses', async () => {
    const { client } = await signInTrainee(api);
    const own = await client.get('/api/trainee/applications');
    expect(own.status).toBe(200);
    expect(headersOf(own)).toEqual(STORE_NOTHING);

    // Not a multipart form: 415 (the submit route accepts only multipart/form-data, traineeRoutes.ts).
    const unsupported = await client.request('POST', '/api/trainee/applications', 'not a form', {
      'content-type': 'text/plain',
    });
    expect(unsupported.status).toBe(415);
    expect(headersOf(unsupported)).toEqual(STORE_NOTHING);

    // A form without the required values: 400 (DomainError, app.ts).
    const invalid = await client.post('/api/trainee/applications', new FormData());
    expect(invalid.status).toBe(400);
    // Raised as a DomainError, so it goes through the error handler, whose own no-cache,no-store is kept.
    expect(headersOf(invalid)).toEqual({ cacheControl: 'no-cache,no-store', nosniff: 'nosniff' });

    const forbidden = await client.get('/api/admin/fields');
    expect(forbidden.status).toBe(403);
    expect(headersOf(forbidden)).toEqual(STORE_NOTHING);

    const missing = await client.get(`/api/hr/applications/${crypto.randomUUID()}/nothing`);
    expect(missing.status).toBe(404);
    expect(headersOf(missing)).toEqual(STORE_NOTHING);

    const method = await client.request('DELETE', '/api/trainee/applications');
    expect(method.status).toBe(405);
    expect(headersOf(method)).toEqual(STORE_NOTHING);
  });

  it('a CORS preflight is covered too', async () => {
    const preflight = await api.fetch(
      new Request('http://localhost/api/auth/me', {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:4200', 'access-control-request-method': 'GET' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(headersOf(preflight)).toEqual(STORE_NOTHING);
  });
});

describe('responses with their own caching policy keep it (and are nosniff)', () => {
  it('unexpected errors keep no-cache,no-store', async () => {
    // The database cannot be reached, so the request fails unexpectedly.
    const failing = await api.fetch(
      new Request('http://localhost/api/auth/trainee/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.251.0.1' },
        body: JSON.stringify({ email: 'headers@uni.example' }),
      }),
      { DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:1/none?sslmode=disable' },
    );
    expect(failing.status).toBe(500);
    expect(headersOf(failing)).toEqual({ cacheControl: 'no-cache,no-store', nosniff: 'nosniff' });
  });

  it('/health keeps its own no-store, no-cache', async () => {
    const health = await api.client().get('/health');
    expect(health.status).toBe(200);
    expect(headersOf(health)).toEqual({ cacheControl: 'no-store, no-cache', nosniff: 'nosniff' });
  });

  it('a response that sets the session cookie keeps no-cache,no-store', async () => {
    const client = api.client();
    const signIn = await client.post('/api/auth/staff/google', {
      idToken: await api.google.issue(uniqueEmail(COMPANY_DOMAIN), COMPANY_DOMAIN),
    });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get('set-cookie')).toMatch(/^ims\.session=/);
    expect(headersOf(signIn)).toEqual({ cacheControl: 'no-cache,no-store', nosniff: 'nosniff' });
  });

  it('a file download keeps private, no-store and its sandbox', async () => {
    const admin = await signInStaff(api, 'Admin');
    const field = await newField(admin.client);
    const trainee = await signInTrainee(api);
    await submitApplication(trainee.client, field.id);
    const [application] = await body<{ attachments: { id: string }[] }[]>(
      await trainee.client.get('/api/trainee/applications'),
    );
    const link = await trainee.client.post(`/api/trainee/attachments/${application!.attachments[0]!.id}/link`);
    expect(headersOf(link)).toEqual(STORE_NOTHING); // the link itself is an ordinary JSON response
    const { url } = await body<{ url: string }>(link);
    const file = await trainee.client.get(url);
    expect(file.status).toBe(200);
    expect(headersOf(file)).toEqual({ cacheControl: 'private, no-store', nosniff: 'nosniff' });
    expect(file.headers.get('content-security-policy')).toMatch(/^sandbox/);
  });
});

describe('rate limiting (B3)', () => {
  it('Retry-After uses the same period as the limiter configured in wrangler.jsonc', () => {
    const limiter = /"name":\s*"TRAINEE_RATE_LIMITER"[^}]*"simple":\s*\{([^}]*)\}/.exec(wranglerConfig);
    expect(limiter, 'TRAINEE_RATE_LIMITER in wrangler.jsonc').not.toBeNull();
    const period = /"period":\s*(\d+)/.exec(limiter![1]!);
    expect(Number(period?.[1])).toBe(RATE_LIMIT_PERIOD_SECONDS);
  });

  it('a rate-limited request says when to retry (the 60-second window); other responses do not', async () => {
    const client = api.client({ ip: '10.252.0.1' });
    for (let i = 0; i < 10; i++) {
      const ok = await client.post('/api/auth/trainee/request', { email: 'retry@uni.example' });
      expect(ok.status).toBe(202);
      expect(ok.headers.get('retry-after')).toBeNull();
    }
    const limited = await client.post('/api/auth/trainee/request', { email: 'retry@uni.example' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(headersOf(limited)).toEqual(STORE_NOTHING);
    expect(await body(limited)).toEqual({ status: 429, traceId: expect.any(String) }); // format unchanged
  });
});
