/** The four roles stored in PostgreSQL (`roles` table, PDF §2). */
export type UserRole = 'Admin' | 'HR' | 'Trainee' | 'Employee';

/**
 * The signed-in user, as returned by `GET /api/auth/me`. A trainee only ever receives their own record.
 * `role` is null for an ordinary Google user outside the staff domain: signed in, but with no role and no staff access.
 */
export interface SessionUser {
  id: string;
  role: UserRole | null;
  email: string;
  name: string | null;
}

/** Public sign-in settings from `GET /api/auth/config` (null Google values = Google sign-in not configured). */
export interface AuthConfig {
  googleClientId: string | null;
  /** The staff Google Workspace domains (informational; the API decides who is staff). */
  googleHostedDomains: string[] | null;
  traineeCodeLifetimeMinutes: number;
}

/** Landing area of each role after sign-in. */
export const ROLE_HOME: Record<UserRole, string> = {
  Admin: '/admin',
  HR: '/hr',
  Employee: '/employee',
  Trainee: '/trainee',
};

/** Page for a signed-in user without a role (an ordinary Google user). */
export const NO_ROLE_HOME = '/account';

/** Where a signed-in user belongs: their role's area, or the account page when they have no role. */
export function homeFor(user: Pick<SessionUser, 'role'>): string {
  return user.role ? ROLE_HOME[user.role] : NO_ROLE_HOME;
}

/**
 * Navigation state of the sign-out buttons, which leave their area for `/` before ending the session (otherwise the
 * area's guard would send them to sign-in): the homepage does not send them back while the session ends.
 */
export const SIGNING_OUT = { signingOut: true } as const;
