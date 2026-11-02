import type { GoogleTokenVerifier } from './auth/google';
import type { Bindings, Settings } from './config';
import type { AuditActor, Database } from './db';
import type { UserRole } from './domain/roles';
import type { EmailSender } from './email';

/**
 * The signed-in user as returned to the client. A trainee only ever receives their own record.
 * `role` is null for an ordinary (non-staff) Google user: signed in, but holding none of the four roles. Such a user
 * has no database record; `id` is `google:<Google subject>`.
 */
export interface SessionUser {
  id: string;
  role: UserRole | null;
  email: string;
  name: string | null;
}

/** Replaceable services (the C# API's DI registrations that tests swap for doubles). */
export interface Dependencies {
  /** TimeProvider. */
  now: () => Date;
  google: GoogleTokenVerifier;
  /** IEmailSender, chosen from the configuration. */
  emailSender: (settings: Settings) => EmailSender;
  /** The per-client limiter of the trainee sign-in endpoints; returns true when the request may proceed. */
  rateLimit: (env: Bindings, key: string) => Promise<boolean>;
}

/** Per-request state (Hono context variables). */
export interface Variables {
  traceId: string;
  settings: Settings;
  db: Database;
  deps: Dependencies;
  /** The signed-in user, re-read from PostgreSQL for this request; null when anonymous. */
  user: SessionUser | null;
  actor: AuditActor;
  /** The `user_sessions` row of the signed-in user's session; null when anonymous. */
  sessionId: string | null;
  /** Set-Cookie to send with the response (sign-in, sign-out, renewal, or clearing an invalid session). */
  sessionCookie: string | null;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
