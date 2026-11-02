import { apiRequest, ApiError, setApiMock } from './api';
import { mockFetch } from '../test/render';

describe('apiRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiMock(null);
  });

  it('sends JSON with the session cookie and returns the JSON body', async () => {
    const fetchMock = mockFetch(() => [200, { ok: true }]);
    expect(await apiRequest('POST', '/admin/fields', { name: 'QA' })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/fields');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: '{"name":"QA"}',
    });
  });

  it('throws ApiError with the ProblemDetails code', async () => {
    mockFetch(() => [403, { code: 'auth.domain_not_allowed' }]);
    const error = await apiRequest('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe('auth.domain_not_allowed');
  });

  it('reports "API unavailable" when no backend answers with JSON (e.g. static hosting only)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const error = (await apiRequest('GET', '/auth/me').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(503);
    expect(error.code).toBe('api_unavailable');
  });

  it.each([404, 405, 502])(
    'treats a non-JSON %i (static host without the API) as "API unavailable"',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('Not Found', { status, headers: { 'content-type': 'text/plain' } }),
        ),
      );
      const error = (await apiRequest('POST', '/auth/trainee/request', {}).catch(
        (e: unknown) => e,
      )) as ApiError;
      expect([error.status, error.code]).toEqual([503, 'api_unavailable']);
    },
  );

  it('keeps the meaning of an empty 401 from the API (signed out)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    expect(
      ((await apiRequest('GET', '/auth/me').catch((e: unknown) => e)) as ApiError).status,
    ).toBe(401);
  });

  it('lets the preview mock answer before the network', async () => {
    const fetchMock = mockFetch(() => [500]);
    setApiMock((method, url) =>
      url === '/api/admin/fields' ? Promise.resolve({ status: 200, body: [method] }) : null,
    );
    expect(await apiRequest('GET', '/admin/fields')).toEqual(['GET']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
