import type { SessionRecord, SessionTicket } from '../../auth/session';
import type { SessionUser } from '../../context';
import type { AuditActor, Database, Queryable } from '../../db';
import { isUserRole } from '../../domain/roles';
import { parseGuid, uuidV7 } from '../../domain/uuid';

/**
 * Server-side sessions (`user_sessions`, AD-44): one row per sign-in, owned by exactly one staff member, trainee or
 * ordinary Google user. The row holds the absolute end and the revocation; it is never deleted (sign-out revokes it).
 * Mirrors the Ims.Domain.Sessions.UserSession entity, whose EF Core migration owns the table.
 */
const GOOGLE_PREFIX = 'google:';

/**
 * Session writes are single statements, so each is one round trip to the database instead of four (BEGIN, actor,
 * write, COMMIT); every sign-in and sign-out pays for them. A single statement is its own transaction: its writes
 * commit or roll back together. `actor` sets the audit actor exactly as Database.transaction does
 * (`set_config(…, true)`, scoped to this transaction, so it cannot leak into later statements), and every write
 * references it, so it is set before the audit triggers run (they fire at the end of the statement). Must not be
 * called inside an open transaction, where the actor would stay set until that transaction ends.
 */
const ACTOR = `actor AS (SELECT set_config('ims.actor_type', $1, true), set_config('ims.actor_id', $2, true))`;

/** Audit actor: staff and trainees by id; an ordinary Google user has no IMS account, so stays Anonymous. */
export function actorFor(user: SessionUser): AuditActor {
  if (user.role === null) return { type: 'Anonymous', id: null };
  return { type: user.role === 'Trainee' ? 'Trainee' : 'Staff', id: user.id };
}

/**
 * Starts a session for `user`, ending `lifetimeMinutes` from now at the latest. Audited as `actor`.
 * `replacing`: the browser's current session, revoked as `Replaced` in the same transaction, so either both happen or
 * neither does. Sessions of other browsers and devices are not touched.
 */
export async function startSession(
  db: Database,
  actor: AuditActor,
  user: SessionUser,
  now: Date,
  lifetimeMinutes: number,
  replacing: string | null = null,
): Promise<SessionRecord> {
  const id = uuidV7(now);
  const expiresAt = new Date(now.getTime() + lifetimeMinutes * 60_000);
  const [column, owner] = ownerOf(user);
  await db.query(
    `WITH ${ACTOR},
          replaced AS (
            UPDATE user_sessions SET revoked_at = $3, revoke_reason = 'Replaced'
             WHERE id = $4 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM actor))
     INSERT INTO user_sessions (id, ${column}, created_at, expires_at) SELECT $5, $6, $3, $7 FROM actor`,
    [actor.type, actor.id ?? '', now, replacing, id, owner, expiresAt],
  );
  return { id, expiresAt };
}

/**
 * The account and session a ticket names, in one query: null when the session is revoked, past its absolute end,
 * not the account's, or the account no longer exists. Staff and trainees are read fresh, so role changes apply at once.
 */
export async function findSignedIn(
  db: Queryable,
  ticket: SessionTicket & { sid: string },
  now: Date,
): Promise<{ user: SessionUser; session: SessionRecord } | null> {
  const sessionId = parseGuid(ticket.sid);
  if (!sessionId) return null;
  const active = 's.id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2';

  if (ticket.role === null) {
    const subject = ticket.sub.slice(GOOGLE_PREFIX.length);
    const { rows } = await db.query<{ expires_at: Date }>(
      `SELECT s.expires_at FROM user_sessions s WHERE ${active} AND s.google_subject = $3`,
      [sessionId, now, subject],
    );
    const row = rows[0];
    return row
      ? {
          user: { id: ticket.sub, role: null, email: ticket.email!, name: ticket.name ?? null },
          session: { id: sessionId, expiresAt: new Date(row.expires_at) },
        }
      : null;
  }

  const userId = parseGuid(ticket.sub);
  if (!userId) return null;

  if (ticket.role === 'Trainee') {
    const { rows } = await db.query<{ id: string; email: string; expires_at: Date }>(
      `SELECT t.id, t.email, s.expires_at FROM user_sessions s JOIN trainees t ON t.id = s.trainee_id
        WHERE ${active} AND t.id = $3`,
      [sessionId, now, userId],
    );
    const row = rows[0];
    return row
      ? {
          user: { id: row.id, role: 'Trainee', email: row.email, name: null },
          session: { id: sessionId, expiresAt: new Date(row.expires_at) },
        }
      : null;
  }

  const { rows } = await db.query<{ id: string; role: string; email: string; full_name: string; expires_at: Date }>(
    `SELECT e.id, e.role, e.email, e.full_name, s.expires_at FROM user_sessions s JOIN employees e ON e.id = s.employee_id
      WHERE ${active} AND e.id = $3`,
    [sessionId, now, userId],
  );
  const row = rows[0];
  if (!row || !isUserRole(row.role)) return null;
  return {
    user: { id: row.id, role: row.role, email: row.email, name: row.full_name },
    session: { id: sessionId, expiresAt: new Date(row.expires_at) },
  };
}

/**
 * Ends a session (sign-out). Revoking it again changes nothing: a session already revoked keeps its first reason.
 * Audited as `actor`, in one statement (see ACTOR).
 */
export async function revokeSession(db: Database, actor: AuditActor, sessionId: string, now: Date): Promise<void> {
  await db.query(
    `WITH ${ACTOR}
     UPDATE user_sessions SET revoked_at = $3, revoke_reason = 'SignOut'
      WHERE id = $4 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM actor)`,
    [actor.type, actor.id ?? '', now, sessionId],
  );
}

function ownerOf(user: SessionUser): ['employee_id' | 'trainee_id' | 'google_subject', string] {
  if (user.role === null) return ['google_subject', user.id.slice(GOOGLE_PREFIX.length)];
  return [user.role === 'Trainee' ? 'trainee_id' : 'employee_id', user.id];
}
