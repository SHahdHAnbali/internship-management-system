import type { SessionUser } from '../../context';
import type { AuditActor, Database } from '../../db';
import { newEmployeeName } from '../../domain/admin';
import { normalizeEmail } from '../../domain/emailAddress';
import { isUserRole, type UserRole } from '../../domain/roles';
import { isNullOrWhiteSpace, toLowerInvariant, trimDotnet } from '../../domain/text';
import { uuidV7 } from '../../domain/uuid';
import type { GoogleTokenVerifier } from '../../auth/google';
import type { Settings } from '../../config';

export type GoogleSignInFailure = 'NotConfigured' | 'InvalidToken' | 'EmailNotVerified';

/**
 * One-time initial Admin (owner decision 2026-10-29, AD-46): the staff account of this exact verified Google Workspace
 * identity is created with the Admin role instead of Employee. It applies only when the account is created, which
 * happens once (accounts are never deleted); every later sign-in reads the saved role, so an Admin's later change to
 * it stands. No other account is ever created as Admin.
 */
const INITIAL_ADMIN = { email: 'mohammad.abujoudeh@progineer.net', hostedDomain: 'progineer.net' } as const;

/**
 * Google sign-in (owner decision AD-42, replacing the PDF's "company domain only"; amended 2026-11-12, B1 to B3):
 * - A verified account whose Google-signed Workspace `hd` claim is one of the staff domains (GOOGLE_HOSTED_DOMAIN, e.g.
 *   `stu.najah.edu` and `progineer.net`), and whose e-mail is in that same domain, is company staff: the first sign-in
 *   creates the staff account with the Employee role; an existing account keeps its Employee/HR/Admin role. Higher
 *   roles are granted only by an Admin; the domain never grants one. This takes precedence over any trainee match.
 * - B1: a verified account whose e-mail is **not** in a staff domain and exactly matches (normalised) an existing
 *   Trainee account signs in as that trainee: the same account, nothing created, merged or changed, no other role.
 * - B3: any other verified Google account signs in as an ordinary, non-staff user: no role, no database record, no
 *   permissions beyond reading their own session. It is never made Employee, HR, Admin or Trainee; a first-time
 *   trainee registers with the e-mailed code.
 */
export async function signInWithGoogle(
  idToken: string,
  context: { db: Database; settings: Settings; google: GoogleTokenVerifier; now: Date },
): Promise<{ user: SessionUser } | { failure: GoogleSignInFailure }> {
  const { db, settings, google, now } = context;
  if (!settings.google.isConfigured) {
    return { failure: 'NotConfigured' };
  }

  const identity = await google.verify(idToken, settings.google.clientId, now);
  if (!identity) {
    return { failure: 'InvalidToken' };
  }

  if (!identity.emailVerified) {
    return { failure: 'EmailNotVerified' };
  }

  const email = normalizeEmail(identity.email);
  const hostedDomain = identity.hostedDomain === null ? null : toLowerInvariant(trimDotnet(identity.hostedDomain));
  const isStaff =
    hostedDomain !== null && settings.google.hostedDomains.includes(hostedDomain) && email.endsWith(`@${hostedDomain}`);
  if (!isStaff) {
    // B1: an existing trainee, matched by the verified e-mail, never for an address in a staff domain (even without a
    // Workspace `hd` claim, e.g. a personal Google account registered with such an address).
    if (!inStaffDomain(email, settings.google.hostedDomains)) {
      const trainee = await findTrainee(db, email);
      if (trainee) return { user: trainee };
    }
    const name = isNullOrWhiteSpace(identity.name) ? null : trimDotnet(identity.name);
    return { user: { id: `google:${identity.subject}`, role: null, email, name } };
  }

  const existing = await findStaff(db, email);
  if (existing) return { user: existing };

  // New staff: Employee, except the one-time initial Admin, whose grant is recorded as made by the system (this rule).
  // Any other new account is recorded as created by its owner, whose Google identity has just been verified.
  const initialAdmin = email === INITIAL_ADMIN.email && hostedDomain === INITIAL_ADMIN.hostedDomain;
  const role: UserRole = initialAdmin ? 'Admin' : 'Employee';
  const employee = {
    id: uuidV7(now),
    email,
    fullName: newEmployeeName(isNullOrWhiteSpace(identity.name) ? email : identity.name),
  };
  const actor: AuditActor = initialAdmin ? { type: 'System', id: null } : { type: 'Staff', id: employee.id };
  const created = await db.transaction(actor, (tx) =>
    tx.query(
      `INSERT INTO employees (id, full_name, email, department, role) VALUES ($1, $2, $3, NULL, $4)
       ON CONFLICT (email) DO NOTHING`,
      [employee.id, employee.fullName, employee.email, role],
    ),
  );
  if (created.rowCount === 0) {
    // A simultaneous first sign-in created the account first: use it, with its saved role.
    const account = await findStaff(db, email);
    if (!account) throw new Error('The staff account could not be created or read.');
    return { user: account };
  }

  return { user: { id: employee.id, role, email: employee.email, name: employee.fullName } };
}

async function findStaff(db: Database, email: string): Promise<SessionUser | null> {
  const { rows } = await db.query<{ id: string; role: string; email: string; full_name: string }>(
    'SELECT id, role, email, full_name FROM employees WHERE email = $1',
    [email],
  );
  const row = rows[0];
  return row && isUserRole(row.role) ? { id: row.id, role: row.role, email: row.email, name: row.full_name } : null;
}

/** Whether the e-mail's domain is one of the staff domains (or a sub-domain of one). */
function inStaffDomain(email: string, staffDomains: readonly string[]): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return staffDomains.some((staff) => domain === staff || domain.endsWith(`.${staff}`));
}

/** The existing trainee with this (normalised) e-mail, as the same session user the e-mailed code produces. */
async function findTrainee(db: Database, email: string): Promise<SessionUser | null> {
  const { rows } = await db.query<{ id: string; email: string }>('SELECT id, email FROM trainees WHERE email = $1', [
    email,
  ]);
  const row = rows[0];
  return row ? { id: row.id, role: 'Trainee', email: row.email, name: null } : null;
}
