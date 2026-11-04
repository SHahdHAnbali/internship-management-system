/**
 * RFC 7807 ProblemDetails responses with the exact shapes the ASP.NET Core API produces (captured from it; see
 * docs in README.md). The React client reads `status` and the `code` extension.
 */
const PROBLEM = 'application/problem+json';
const PROBLEM_UTF8 = 'application/problem+json; charset=utf-8';

const STATUS: Record<number, { title: string; section: string }> = {
  400: { title: 'Bad Request', section: '15.5.1' },
  401: { title: 'Unauthorized', section: '15.5.2' },
  403: { title: 'Forbidden', section: '15.5.4' },
  404: { title: 'Not Found', section: '15.5.5' },
  405: { title: 'Method Not Allowed', section: '15.5.6' },
  409: { title: 'Conflict', section: '15.5.10' },
  415: { title: 'Unsupported Media Type', section: '15.5.16' },
  500: { title: 'An error occurred while processing your request.', section: '15.6.1' },
  503: { title: 'Service Unavailable', section: '15.6.4' },
};

function type(status: number): string {
  return `https://tools.ietf.org/html/rfc9110#section-${STATUS[status]!.section}`;
}

function respond(status: number, body: unknown, contentType: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType, ...headers } });
}

/** A W3C trace id in ASP.NET's `traceId` format (`00-<trace>-<span>-00`). */
export function newTraceId(): string {
  const hex = (bytes: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `00-${hex(16)}-${hex(8)}-00`;
}

/**
 * Status-only problem: 401/403 from authorization (`charset` true), or 401/404/405 written for requests that match
 * no endpoint (`charset` false, ASP.NET's status-code pages).
 */
export function statusProblem(status: number, traceId: string, charset: boolean, headers?: Record<string, string>) {
  const body = { type: type(status), title: STATUS[status]!.title, status, traceId };
  return respond(status, body, charset ? PROBLEM_UTF8 : PROBLEM, headers);
}

/** A failure returned by an endpoint itself (AuthController's `Failure(...)`): status, detail and code only. */
export function endpointFailure(status: number, code: string, detail: string): Response {
  return respond(status, { status, detail, code }, PROBLEM_UTF8);
}

/** Headers ASP.NET's exception handler adds to every response it writes. */
const NO_CACHE = { 'Cache-Control': 'no-cache,no-store', Expires: '-1', Pragma: 'no-cache' };

/** A domain/data error mapped by the exception handler (ApiExceptionHandler). */
export function errorProblem(status: number, code: string, detail: string, traceId: string): Response {
  const body = { type: type(status), title: STATUS[status]!.title, status, detail, code, traceId };
  return respond(status, body, PROBLEM, NO_CACHE);
}

/** Model validation failure (`[ApiController]` automatic 400). Keys are the C# property names or JSON paths. */
export function validationProblem(errors: Record<string, string[]>, traceId: string): Response {
  const body = {
    type: type(400),
    title: 'One or more validation errors occurred.',
    status: 400,
    errors,
    traceId,
  };
  return respond(400, body, PROBLEM_UTF8);
}

/** The rate limiter's rejection: the same body as before, plus when to try again (the limiter's window). */
export function tooManyRequests(traceId: string, retryAfterSeconds: number): Response {
  return respond(429, { status: 429, traceId }, PROBLEM_UTF8, { 'Retry-After': String(retryAfterSeconds) });
}

/** Unhandled error: no details are exposed (they are logged). */
export function internalError(traceId: string): Response {
  return respond(500, { type: type(500), title: STATUS[500]!.title, status: 500, traceId }, PROBLEM_UTF8, NO_CACHE);
}

/** A successful JSON response (`application/json; charset=utf-8`). */
export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return respond(status, body, 'application/json; charset=utf-8', headers);
}
