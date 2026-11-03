import type { Context } from 'hono';
import { expiredSessionCookie, newTicket, protectTicket, sessionCookie } from '../../auth/session';
import type { AppEnv, SessionUser } from '../../context';
import { EMAIL_MAX_LENGTH } from '../../domain/emailAddress';
import { isNullOrWhiteSpace } from '../../domain/text';
import { bindJson, type RequestSchema } from '../../http/body';
import { endpointFailure, json, statusProblem } from '../../http/problems';
import type { Route } from '../../http/routes';
import { actorFor, revokeSession, startSession } from './sessions';
import { signInWithGoogle, type GoogleSignInFailure } from './staffSignIn';
import { requestCode, verifyCode, verifyToken, type TraineeSignInContext } from './traineeSignIn';

/**
 * `/api/auth`: sign-in for staff (Google, company domain) and trainees (one-time e-mail link or code), session,
 * sign-out. Mirrors Ims.Api.Controllers.AuthController.
 */
const googleSignInRequest: RequestSchema = {
  typeName: 'Ims.Application.Auth.GoogleSignInRequest',
  properties: [{ name: 'IdToken', kind: 'string', required: true }],
};

const traineeCodeRequest: RequestSchema = {
  typeName: 'Ims.Application.Auth.TraineeCodeRequest',
  properties: [{ name: 'Email', kind: 'string', required: true, maxLength: EMAIL_MAX_LENGTH }],
};

const traineeCodeVerification: RequestSchema = {
  typeName: 'Ims.Application.Auth.TraineeCodeVerification',
  properties: [
    { name: 'Email', kind: 'string', maxLength: EMAIL_MAX_LENGTH },
    { name: 'Code', kind: 'string', maxLength: 6 },
    { name: 'Token', kind: 'string', maxLength: 64 },
  ],
};

const GOOGLE_FAILURES: Record<GoogleSignInFailure, [number, string, string]> = {
  NotConfigured: [503, 'auth.google_not_configured', 'Google sign-in is not configured on the server.'],
  EmailNotVerified: [401, 'auth.email_not_verified', "The Google account's e-mail is not verified."],
  InvalidToken: [401, 'auth.invalid_token', 'The Google sign-in could not be verified.'],
};

export const authRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/auth/config',
    policy: 'anonymous',
    async handle(c) {
      const { google, trainee } = c.var.settings;
      return json({
        googleClientId: google.isConfigured ? google.clientId : null,
        googleHostedDomains: google.isConfigured ? google.hostedDomains : null,
        traineeCodeLifetimeMinutes: trainee.codeLifetimeMinutes,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/staff/google',
    policy: 'anonymous',
    async handle(c) {
      const body = await bindJson<{ idToken: string }>(c.req.raw, googleSignInRequest, c.var.traceId);
      if (!body.ok) return body.response;

      const result = await signInWithGoogle(body.value.idToken, {
        db: c.var.db,
        settings: c.var.settings,
        google: c.var.deps.google,
        now: c.var.deps.now(),
      });
      if ('failure' in result) {
        return endpointFailure(...GOOGLE_FAILURES[result.failure]);
      }

      return signIn(c, result.user);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/trainee/request',
    policy: 'anonymous',
    rateLimited: true,
    async handle(c) {
      const body = await bindJson<{ email: string }>(c.req.raw, traineeCodeRequest, c.var.traceId);
      if (!body.ok) return body.response;

      await requestCode(body.value.email, traineeContext(c));
      return new Response(null, { status: 202 });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/trainee/verify',
    policy: 'anonymous',
    rateLimited: true,
    async handle(c) {
      const body = await bindJson<{ email: string | null; code: string | null; token: string | null }>(
        c.req.raw,
        traineeCodeVerification,
        c.var.traceId,
      );
      if (!body.ok) return body.response;

      const { email, code, token } = body.value;
      let user: SessionUser | null;
      if (!isNullOrWhiteSpace(token)) {
        user = await verifyToken(token, traineeContext(c));
      } else if (!isNullOrWhiteSpace(email) && !isNullOrWhiteSpace(code)) {
        user = await verifyCode(email, code, traineeContext(c));
      } else {
        return endpointFailure(400, 'validation.required', 'Provide either the link token, or the e-mail and code.');
      }

      if (!user) {
        return endpointFailure(
          400,
          'auth.invalid_code',
          'The sign-in link or code is invalid, expired or already used.',
        );
      }

      return signIn(c, user);
    },
  },
  {
    // The signed-in user's own account (fresh from the database). Never exposes other users.
    method: 'GET',
    path: '/api/auth/me',
    policy: 'authenticated',
    async handle(c) {
      const user = c.var.user;
      return user ? json(user) : statusProblem(401, c.var.traceId, true);
    },
  },
  {
    method: 'POST',
    path: '/api/auth/sign-out',
    policy: 'anonymous',
    async handle(c) {
      // The browser forgets the cookie, and the session is revoked server-side, so a copy of the cookie is refused too.
      c.set('sessionCookie', expiredSessionCookie(isSecure(c)));
      const sessionId = c.var.sessionId;
      if (sessionId) await revokeSession(c.var.db, c.var.actor, sessionId, c.var.deps.now());
      return new Response(null, { status: 204 });
    },
  },
];

function traineeContext(c: Context<AppEnv>): TraineeSignInContext {
  return {
    db: c.var.db,
    actor: c.var.actor,
    settings: c.var.settings,
    email: c.var.deps.emailSender(c.var.settings),
    now: c.var.deps.now(),
  };
}

/**
 * Starts a server-side session for `user`, issues its cookie and returns the user (200). Reached only after a successful
 * sign-in. If this browser already holds a valid session, the new one replaces it: it is revoked (`Replaced`) in the
 * same transaction, as the browser keeps only the new cookie.
 */
async function signIn(c: Context<AppEnv>, user: SessionUser): Promise<Response> {
  const { settings, deps } = c.var;
  const now = deps.now();
  // Recorded as the user who has just been verified (not the request's actor, which is whoever was signed in before:
  // usually nobody). That user's sign-in also replaces this browser's previous session, in the same statement.
  const session = await startSession(
    c.var.db,
    actorFor(user),
    user,
    now,
    settings.sessionAbsoluteLifetimeMinutes,
    c.var.sessionId,
  );
  const ticket = newTicket(user, session, now, settings.sessionIdleTimeoutMinutes);
  c.set(
    'sessionCookie',
    sessionCookie(await protectTicket(ticket, settings.sessionSecrets[0]!), ticket, now, isSecure(c)),
  );
  return json(user);
}

/** `Secure` always, except over plain HTTP in development (CookieSecurePolicy.SameAsRequest). */
export function isSecure(c: Context<AppEnv>): boolean {
  return !c.var.settings.isDevelopment || new URL(c.req.url).protocol === 'https:';
}
