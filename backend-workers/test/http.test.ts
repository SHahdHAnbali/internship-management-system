import { describe, expect, it } from 'vitest';
import { body, createTestApi, signInTrainee } from './helpers';

/**
 * The HTTP contract of the ASP.NET Core API, as captured from it (status codes, ProblemDetails shapes, content types,
 * routing, CORS, health). The React client depends on the status codes and the `code` extension.
 */
const api = createTestApi();
const request = (path: string, init: RequestInit = {}) => api.fetch(new Request(`http://localhost${path}`, init));
const post = (path: string, raw: string | null, contentType: string | null = 'application/json') =>
  request(path, {
    method: 'POST',
    headers: {
      ...(contentType ? { 'content-type': contentType } : {}),
      'cf-connecting-ip': `10.1.${Math.floor(Math.random() * 250)}.1`,
    },
    ...(raw === null ? {} : { body: raw }),
  });

describe('routing', () => {
  it('requests that match no endpoint are 401 when anonymous (fallback policy), without a charset', async () => {
    for (const [method, path] of [
      ['GET', '/api/nope'],
      ['GET', '/nope'],
      ['DELETE', '/api/auth/config'],
      ['DELETE', '/api/admin/fields'],
      ['PUT', '/api/admin/fields/not-a-guid'],
      ['OPTIONS', '/api/auth/me'],
    ] as const) {
      const response = await request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
    }
  });

  it('signed in: 404 for unknown paths (and non-GUID ids), 405 with Allow for other methods', async () => {
    const { client } = await signInTrainee(api);
    const notFound = await client.get('/api/nope');
    expect(notFound.status).toBe(404);
    expect(await body(notFound)).toMatchObject({
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5',
      title: 'Not Found',
      status: 404,
    });
    expect((await client.put('/api/admin/fields/not-a-guid', { name: 'x' })).status).toBe(404);

    const wrongMethod = await client.request('DELETE', '/api/admin/fields');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, POST');
    expect(await body(wrongMethod)).toMatchObject({ title: 'Method Not Allowed', status: 405 });
    expect((await client.request('DELETE', '/api/auth/me')).headers.get('allow')).toBe('GET');
    expect((await client.request('HEAD', '/api/auth/me')).status).toBe(405);
  });

  it('paths are case-insensitive and ignore a trailing slash; GUIDs are accepted in N, D, B and P formats', async () => {
    expect((await request('/API/Auth/Config')).status).toBe(200);
    expect((await request('/api/auth/config/')).status).toBe(200);

    const { client } = await signInTrainee(api);
    const id = crypto.randomUUID();
    for (const form of [id, id.toUpperCase(), id.replace(/-/g, ''), `%7B${id}%7D`, `(${id})`]) {
      // A trainee is refused (403) only when the route matched; an id that is not a GUID would be 404.
      expect((await client.put(`/api/admin/fields/${form}`, { name: 'x' })).status, form).toBe(403);
    }
  });
});

describe('request validation (ASP.NET [ApiController] model binding)', () => {
  it('a missing or blank required value', async () => {
    for (const raw of ['{}', '{"idToken":null}', '{"idToken":"  "}']) {
      const response = await post('/api/auth/staff/google', raw);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
      const problem = await body(response);
      expect(problem).toMatchObject({
        type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { IdToken: ['The IdToken field is required.'] },
      });
      expect(problem.traceId).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    }
  });

  it('malformed, empty or wrongly typed bodies', async () => {
    const errors = async (path: string, raw: string) =>
      (await body<{ errors: Record<string, string[]> }>(await post(path, raw))).errors;
    expect(Object.keys(await errors('/api/auth/staff/google', '{nope'))).toEqual(['$', 'request']);
    expect(await errors('/api/auth/staff/google', '')).toEqual({
      '': ['A non-empty request body is required.'],
      request: ['The request field is required.'],
    });
    expect(Object.keys(await errors('/api/auth/staff/google', '{"idToken":5}'))).toEqual(['request', '$.idToken']);
    expect(Object.keys(await errors('/api/auth/trainee/request', '[1]'))).toEqual(['$', 'request']);
    expect(await errors('/api/auth/trainee/request', 'null')).toEqual({
      '': ['A non-empty request body is required.'],
      request: ['The request field is required.'],
    });
  });

  it('non-JSON content types are 415', async () => {
    for (const contentType of ['text/plain', null]) {
      const response = await post('/api/auth/staff/google', 'x', contentType);
      expect(response.status).toBe(415);
      expect(await body(response)).toMatchObject({ title: 'Unsupported Media Type', status: 415 });
    }

    expect((await post('/api/auth/staff/google', '{"idToken":"x"}', 'application/json; charset=utf-8')).status).toBe(
      401,
    );
  });

  it('maximum lengths and domain errors', async () => {
    const tooLong = await post(
      '/api/auth/trainee/request',
      JSON.stringify({ email: `${'a'.repeat(310)}@uni.example` }),
    );
    expect((await body(tooLong)).errors).toEqual({
      Email: ["The field Email must be a string or array type with a maximum length of '320'."],
    });

    const invalid = await post('/api/auth/trainee/request', JSON.stringify({ email: 'Sara <sara@uni.example>' }));
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('content-type')).toBe('application/problem+json');
    expect(await body(invalid)).toMatchObject({
      type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
      title: 'Bad Request',
      status: 400,
      detail: 'Email is not a valid address.',
      code: 'validation.email',
    });
  });

  it('verify: token, or e-mail and code, are required', async () => {
    for (const raw of ['{}', '{"email":"a@uni.example"}', '{"token":"   "}']) {
      expect(await body(await post('/api/auth/trainee/verify', raw))).toEqual({
        status: 400,
        detail: 'Provide either the link token, or the e-mail and code.',
        code: 'validation.required',
      });
    }

    expect(
      (await body(await post('/api/auth/trainee/verify', '{"email":"a@uni.example","code":"1234567"}'))).errors,
    ).toEqual({
      Code: ["The field Code must be a string or array type with a maximum length of '6'."],
    });
  });
});

describe('CORS (configured origins, with credentials)', () => {
  it('answers preflight requests from allowed origins only', async () => {
    const preflight = (origin: string) =>
      request('/api/auth/me', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });

    const allowed = await preflight('http://localhost:4200');
    expect(allowed.status).toBe(204);
    expect(Object.fromEntries([...allowed.headers].filter(([k]) => k.startsWith('access-control')))).toEqual({
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST',
      'access-control-allow-origin': 'http://localhost:4200',
    });

    const other = await preflight('https://evil.example');
    expect(other.status).toBe(204);
    expect([...other.headers].filter(([k]) => k.startsWith('access-control'))).toEqual([]);
  });

  it('adds the CORS headers to responses for allowed origins', async () => {
    const allowed = await request('/api/auth/config', { headers: { origin: 'http://localhost:4200' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:4200');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const other = await request('/api/auth/config', { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('health', () => {
  it('reports Healthy when PostgreSQL is reachable, for any method', async () => {
    for (const method of ['GET', 'POST', 'HEAD']) {
      const response = await request('/health', { method });
      expect(response.status, method).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(response.headers.get('cache-control')).toBe('no-store, no-cache');
      if (method !== 'HEAD') expect(await response.text()).toBe('Healthy');
    }
  });

  it('reports Unhealthy (503) when the database is unreachable or not configured', async () => {
    const down = await api.fetch(new Request('http://localhost/health'), {
      DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:1/none?sslmode=disable',
    });
    expect(down.status).toBe(503);
    expect(await down.text()).toBe('Unhealthy');

    const unconfigured = await api.fetch(new Request('http://localhost/health'), { DATABASE_URL: '' });
    expect(unconfigured.status).toBe(503);
  });
});

describe('errors', () => {
  it('unexpected errors are 500 without details', async () => {
    const response = await api.fetch(
      new Request('http://localhost/api/auth/trainee/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.250.0.1' },
        body: JSON.stringify({ email: 'a@uni.example' }),
      }),
      { DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:1/none?sslmode=disable' },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache,no-store');
    const problem = await body(response);
    expect(Object.keys(problem)).toEqual(['type', 'title', 'status', 'traceId']);
    expect(problem).toMatchObject({ title: 'An error occurred while processing your request.', status: 500 });
  });
});

describe('rate limiting (trainee sign-in, per client)', () => {
  it('allows 10 requests per minute per client across both trainee endpoints, then 429', async () => {
    const client = api.client({ ip: '10.77.0.1' });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++)
      statuses.push((await client.post('/api/auth/trainee/request', { email: 'limit@uni.example' })).status);
    expect(statuses).toEqual(Array(10).fill(202));

    const limited = await client.post('/api/auth/trainee/verify', { token: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(Object.keys(await body(limited))).toEqual(['status', 'traceId']);
    expect(limited.headers.get('retry-after')).toBe('60'); // the limiter's window

    // Another client is not affected; other endpoints are not limited.
    expect(
      (await api.client({ ip: '10.77.0.2' }).post('/api/auth/trainee/request', { email: 'limit@uni.example' })).status,
    ).toBe(202);
    expect((await client.get('/api/auth/config')).status).toBe(200);
  });
});
