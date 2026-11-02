/** Base URL of the ASP.NET Core API. In development `/api` is proxied to the backend by Vite (vite.config.ts). */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || '/api';

/** An HTTP error from the API. `body` is the RFC 7807 ProblemDetails (with a `code` extension) when available. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }

  get code(): string | undefined {
    return (this.body as { code?: string } | null)?.code;
  }
}

export interface MockResponse {
  status: number;
  body?: unknown;
}

/** Local Admin Preview Mode only: answers some requests in the browser (see src/features/admin/preview). */
export type ApiMock = (method: string, url: string, body: unknown) => Promise<MockResponse> | null;

let mock: ApiMock | null = null;

export function setApiMock(handler: ApiMock | null): void {
  mock = handler;
}

/**
 * Calls the API with the session cookie (same origin). Throws {@link ApiError} for non-2xx responses, and a 503
 * `api_unavailable` error when the response is not the API's JSON (e.g. no backend behind this host).
 */
export async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE_URL}${path}`;
  const mocked = mock?.(method, url, body ?? null);
  if (mocked) {
    const response = await mocked;
    if (response.status >= 400) throw new ApiError(response.status, response.body ?? null);
    return response.body as T;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      // A Blob (e.g. an uploaded image) is sent as-is with its own type; FormData as multipart (the browser sets the
      // type with its boundary); anything else as JSON.
      headers:
        body === undefined || body instanceof FormData
          ? undefined
          : { 'Content-Type': body instanceof Blob ? body.type : 'application/json' },
      body:
        body === undefined
          ? undefined
          : body instanceof Blob || body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { code: 'network_error' });
  }

  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    // The API answers 404/405/5xx with JSON ProblemDetails; a non-JSON answer means no API is behind this host
    // (e.g. the static site alone). 401/403 from the API legitimately have no body and keep their meaning.
    if (!isJson && response.status !== 401 && response.status !== 403) {
      throw new ApiError(503, { code: 'api_unavailable' });
    }

    throw new ApiError(response.status, payload);
  }

  if (response.status === 202 || response.status === 204) {
    return undefined as T;
  }

  if (!isJson) {
    throw new ApiError(503, { code: 'api_unavailable' });
  }

  return payload as T;
}
