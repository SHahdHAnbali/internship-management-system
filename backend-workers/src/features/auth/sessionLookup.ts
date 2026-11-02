import type { SessionUser } from '../../context';
import type { Queryable } from '../../db';
import { isUserRole } from '../../domain/roles';
import { parseGuid } from '../../domain/uuid';

/**
 * Reads the current state of a signed-in account from PostgreSQL. Used on every request, so role changes made by an
 * Admin take effect immediately. Returns only the caller's own record. Mirrors Ims.Application.Auth.SessionLookup.
 */
export async function findSessionUser(db: Queryable, userId: string, isTrainee: boolean): Promise<SessionUser | null> {
  const id = parseGuid(userId);
  if (!id) return null;

  if (isTrainee) {
    const { rows } = await db.query<{ id: string; email: string }>('SELECT id, email FROM trainees WHERE id = $1', [
      id,
    ]);
    const trainee = rows[0];
    return trainee ? { id: trainee.id, role: 'Trainee', email: trainee.email, name: null } : null;
  }

  const { rows } = await db.query<{ id: string; role: string; email: string; full_name: string }>(
    'SELECT id, role, email, full_name FROM employees WHERE id = $1',
    [id],
  );
  const employee = rows[0];
  if (!employee || !isUserRole(employee.role)) return null;
  return { id: employee.id, role: employee.role, email: employee.email, name: employee.full_name };
}
