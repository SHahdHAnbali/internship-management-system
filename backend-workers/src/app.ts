import { Hono, type Context, type Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { createGoogleVerifier, googleKeySource } from './auth/google';
import {
  SESSION_COOKIE,
  expiredSessionCookie,
  needsRenewal,
  newTicket,
  protectTicket,
  sessionCookie,
  unprotectTicket,
} from './auth/session';
import { loadSettings, type Bindings } from './config';
import type { AppEnv, Dependencies } from './context';
import { Database, sqlState } from './db';
import {
  ConcurrencyError,
  ConfigurationError,
  DomainError,
  EmailNotConfiguredError,
  EmailSendError,
  NotFoundError,
} from './domain/errors';
import { emailSenderFor } from './email';
import { auditLogRoutes } from './features/admin/auditLogRoutes';
import { adminRoutes } from './features/admin/routes';
import { certificateTemplateRoutes } from './features/admin/certificateTemplate';
import { authRoutes, isSecure } from './features/auth/routes';
import { notificationRoutes } from './features/notifications/routes';
import { fieldsReportRoutes } from './features/reports/fieldsReport';
import { mentorProfileRoutes } from './features/reports/mentorProfileReport';
import { reportRoutes } from './features/reports/monthlyReport';
import { adminTraineeRoutes } from './features/training/adminTraineeRoutes';
import { employeeRoutes } from './features/training/employeeRoutes';
import { fileRoutes } from './features/training/files';
import { hrRoutes } from './features/training/hrRoutes';
import { traineeRoutes } from './features/training/traineeRoutes';
import { findSessionUser } from './features/auth/sessionLookup';
import { actorFor, findSignedIn, startSession } from './features/auth/sessions';
import { errorProblem, internalError, newTraceId, statusProblem, tooManyRequests } from './http/problems';
import { matchesTemplate, routingPath, type Route } from './http/routes';

/**
 * The IMS API on Cloudflare Workers. The request pipeline follows the ASP.NET Core API (Program.cs):
 * CORS → authentication (session cookie, account re-read from PostgreSQL) → authorization (secure by default) →
 * rate limiting → endpoint, with errors mapped to ProblemDetails like ApiExceptionHandler.
 */
export const routes: Route[] = [
  ...authRoutes,
  ...adminRoutes,
  ...auditLogRoutes,
  ...certificateTemplateRoutes,
  ...adminTraineeRoutes,
  ...traineeRoutes,
  ...hrRoutes,
  ...employeeRoutes,
  ...reportRoutes,
  ...fieldsReportRoutes,
  ...mentorProfileRoutes,
  ...fileRoutes,
  ...notificationRoutes,
];

/**
 * The rate limiter's window in seconds (`Retry-After` of its 429): `"period"` of `TRAINEE_RATE_LIMITER` in wrangler.jsonc.
 * test/security-headers.test.ts fails if the two differ.
 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export const productionDependencies: Dependencies = {
  now: () => new Date(),
  google: createGoogleVerifier(googleKeySource, (reason) =>
    console.warn(JSON.stringify({ level: 'warn', message: 'Rejected Google ID token', reason })),
  ),
  emailSender: emailSenderFor,
  async rateLimit(env: Bindings, key: string) {
    if (!env.TRAINEE_RATE_LIMITER) {
      throw new ConfigurationError('The TRAINEE_RATE_LIMITER binding is missing (wrangler.jsonc "ratelimits").');
    }

    return (await env.TRAINEE_RATE_LIMITER.limit({ key })).success;
  },
};

export function createApp(dependencies: Dependencies = productionDependencies) {
  const app = new Hono<AppEnv>({ getPath: (request) => routingPath(new URL(request.url).pathname) });

  app.use(securityHeaders); // first, so it covers every response, errors included
  app.use(async (c, next) => {
    c.set('traceId', newTraceId());
    c.set('deps', dependencies);
    try {
      c.set('settings', loadSettings(c.env));
    } catch (error) {
      if (c.req.path === '/health') return unhealthy(error);
      throw error;
    }

    c.set('db', new Database(c.var.settings.databaseUrl));
    try {
      await next();
    } finally {
      c.executionCtx.waitUntil(c.var.db.close());
    }
  });

  app.use(cors);
  app.use(authenticate);

  // Health check: any method, anonymous (MapHealthChecks("/health")).
  app.all('/health', async (c) => {
    try {
      await c.var.db.query('SELECT 1');
      return new Response('Healthy', { status: 200, headers: healthHeaders });
    } catch (error) {
      return unhealthy(error);
    }
  });

  // Controller actions are not mapped for HEAD; treat it as an unknown route (Hono would otherwise run GET handlers).
  app.use(async (c, next) => (c.req.method === 'HEAD' ? noEndpoint(c) : next()));

  for (const route of routes) {
    app.on(route.method, route.path, async (c) => {
      if (!matchesTemplate(route.path, c.req.path)) return noEndpoint(c); // e.g. `:id` is not a GUID

      const user = c.var.user;
      if (route.policy !== 'anonymous') {
        if (!user) return statusProblem(401, c.var.traceId, true);
        if (route.policy !== 'authenticated' && user.role !== route.policy) {
          return statusProblem(403, c.var.traceId, true);
        }
      }

      if (route.rateLimited) {
        const client = c.req.header('cf-connecting-ip') ?? 'unknown';
        if (!(await c.var.deps.rateLimit(c.env, client))) {
          return tooManyRequests(c.var.traceId, RATE_LIMIT_PERIOD_SECONDS);
        }
      }

      return route.handle(c);
    });
  }

  app.notFound(noEndpoint);
  app.onError((error, c) => {
    const traceId = c.var.traceId ?? newTraceId();
    if (error instanceof DomainError) return errorProblem(400, error.code, error.message, traceId);
    if (error instanceof NotFoundError) return errorProblem(404, 'not_found', error.message, traceId);
    if (error instanceof EmailSendError) {
      return errorProblem(503, 'email.send_failed', 'The e-mail could not be sent. Please try again later.', traceId);
    }
    if (error instanceof EmailNotConfiguredError) {
      return errorProblem(503, 'email.not_configured', 'E-mail sending is not configured on the server.', traceId);
    }

    if (error instanceof ConcurrencyError) {
      return errorProblem(
        409,
        'conflict.concurrent_update',
        'The record was changed by someone else. Reload and try again.',
        traceId,
      );
    }

    if (sqlState(error) === '23505') {
      return errorProblem(409, 'conflict.duplicate', 'A record with the same value already exists.', traceId);
    }

    console.error(
      JSON.stringify({
        level: 'error',
        message: error instanceof ConfigurationError ? 'Configuration error' : 'Unhandled error',
        traceId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    return internalError(traceId);
  });

  return app;
}

/**
 * No endpoint matches: ASP.NET's fallback authorization policy still applies (anonymous → 401); otherwise 405 with
 * `Allow` when the path exists for other methods, else 404.
 */
function noEndpoint(c: Context<AppEnv>): Response {
  if (!c.var.user) return statusProblem(401, c.var.traceId, false);

  const allowed = routes.filter((route) => matchesTemplate(route.path, c.req.path)).map((route) => route.method);
  return allowed.length > 0
    ? statusProblem(405, c.var.traceId, false, { Allow: [...new Set(allowed)].join(', ') })
    : statusProblem(404, c.var.traceId, false);
}

/**
 * Every response that does not set its own policy is never stored by a browser or proxy (API data are personal and
 * change with each request) and never MIME-sniffed. Responses with their own `Cache-Control` keep it: files and
 * certificate images (`private, no-store`), session cookies and errors (`no-cache,no-store`), `/health`. The headers
 * that only matter for HTML pages (CSP, frame and referrer policies) come from `_headers` on the static site.
 */
async function securityHeaders(c: Context<AppEnv>, next: Next) {
  await next();
  const headers = c.res.headers;
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
}

/**
 * CORS for the configured origins with credentials, any method and header (the C# "Frontend" policy). Preflight
 * requests are answered here (204); responses to allowed origins get the CORS headers.
 */
async function cors(c: Context<AppEnv>, next: Next) {
  const origin = c.req.header('origin');
  const allowed =
    origin !== undefined && c.var.settings.corsAllowedOrigins.some((o) => o.toLowerCase() === origin.toLowerCase());
  const requestedMethod = c.req.header('access-control-request-method');

  if (c.req.method === 'OPTIONS' && origin !== undefined && requestedMethod !== undefined) {
    const headers = new Headers();
    if (allowed) {
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', requestedMethod);
      const requestedHeaders = c.req.header('access-control-request-headers');
      if (requestedHeaders) headers.set('Access-Control-Allow-Headers', requestedHeaders);
    }

    return new Response(null, { status: 204, headers });
  }

  await next();
  if (allowed) {
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    // ASP.NET adds Vary only when the answer depends on which of several origins asked.
    if (c.var.settings.corsAllowedOrigins.length > 1) c.res.headers.append('Vary', 'Origin');
  }
}

/**
 * Reads the session cookie, checks its `user_sessions` row (not revoked, before its absolute end; AD-44) and re-reads
 * the account from PostgreSQL on every request (AD-33): a removed account or a revoked session is signed out, and a
 * role changed by an Admin applies immediately (the cookie is re-issued with it).
 */
async function authenticate(c: Context<AppEnv>, next: Next) {
  c.set('user', null);
  c.set('actor', { type: 'Anonymous', id: null });
  c.set('sessionId', null);
  c.set('sessionCookie', null);

  const value = getCookie(c, SESSION_COOKIE);
  const { settings, deps } = c.var;
  if (value) {
    const now = deps.now();
    const ticket = await unprotectTicket(value, settings.sessionSecrets, now);
    let signedIn = null;
    if (ticket?.sid !== undefined) {
      signedIn = await findSignedIn(c.var.db, { ...ticket, sid: ticket.sid }, now);
    } else if (ticket) {
      // A ticket from before AD-44 (no session row, at most 8 hours old): kept signed in by moving it to a new session.
      const user =
        ticket.role === null
          ? { id: ticket.sub, role: null, email: ticket.email!, name: ticket.name ?? null }
          : await findSessionUser(c.var.db, ticket.sub, ticket.role === 'Trainee');
      if (user) {
        const session = await startSession(
          c.var.db,
          actorFor(user),
          user,
          now,
          settings.sessionAbsoluteLifetimeMinutes,
        );
        signedIn = { user, session };
      }
    }

    if (ticket && !signedIn) {
      c.set('sessionCookie', expiredSessionCookie(isSecure(c)));
    } else if (ticket && signedIn) {
      const { user, session } = signedIn;
      c.set('user', user);
      c.set('actor', actorFor(user));
      c.set('sessionId', session.id);

      if (
        ticket.sid === undefined ||
        user.role !== ticket.role ||
        needsRenewal(ticket, now, settings.sessionIdleTimeoutMinutes)
      ) {
        const renewed = newTicket(user, session, now, settings.sessionIdleTimeoutMinutes);
        const protectedTicket = await protectTicket(renewed, settings.sessionSecrets[0]!);
        c.set('sessionCookie', sessionCookie(protectedTicket, renewed, now, isSecure(c)));
      }
    }
  }

  await next();
  const cookie = c.var.sessionCookie;
  if (cookie) {
    // As ASP.NET's cookie authentication does: a response that sets the session cookie must never be cached.
    c.res.headers.append('Set-Cookie', cookie);
    c.res.headers.set('Cache-Control', 'no-cache,no-store');
    c.res.headers.set('Expires', 'Thu, 01 Jan 1970 00:00:00 GMT');
    c.res.headers.set('Pragma', 'no-cache');
  }
}

const healthHeaders = {
  'Content-Type': 'text/plain',
  'Cache-Control': 'no-store, no-cache',
  Expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
  Pragma: 'no-cache',
};

function unhealthy(error: unknown): Response {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Health check failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return new Response('Unhealthy', { status: 503, headers: healthHeaders });
}
