import type { Queryable } from '../../db';
import { uuidV7 } from '../../domain/uuid';

/**
 * In-app notifications (PDF §7, the events whose channel includes "إشعار"; PDF §8 Notification: recipient, type, read
 * or not). Only the events whose workflow exists are written: a new training application and an employee's request to
 * train a trainee (to the application's current responsible HR only, AD-64), and HR approving or rejecting that
 * request (to the employee who asked), and HR assigning a trainee directly to an employee (to that employee, AD-67; the
 * record is the training application). The other in-app events (training ending in 7 days, training ended, new trainee
 * in your field) wait for their features or decisions.
 */
export const NOTIFICATION_TYPES = [
  'ApplicationSubmitted',
  'MentorRequestSubmitted',
  'MentorRequestApproved',
  'MentorRequestRejected',
  'TraineeDirectlyAssigned',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Who receives each type (PDF §7 "المستلم"). */
export const TYPES_BY_ROLE: Record<'HR' | 'Employee', readonly NotificationType[]> = {
  HR: ['ApplicationSubmitted', 'MentorRequestSubmitted'],
  Employee: ['MentorRequestApproved', 'MentorRequestRejected', 'TraineeDirectlyAssigned'],
};

/**
 * Notifies one staff member, inside the transaction of the event itself, so it exists exactly when the event does. A
 * repeated write for the same recipient, type and record adds nothing (unique index).
 */
export async function notifyEmployee(
  tx: Queryable,
  recipientId: string,
  type: NotificationType,
  entityId: string,
  now: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO notifications (id, recipient_id, type, entity_id, is_read, created_at)
     VALUES ($1, $2, $3, $4, false, $5)
     ON CONFLICT (recipient_id, type, entity_id) DO NOTHING`,
    [uuidV7(now), recipientId, type, entityId, now],
  );
}

/** Notifies every staff member who holds the HR role when the event happens. */
export async function notifyHr(tx: Queryable, type: NotificationType, entityId: string, now: Date): Promise<void> {
  const { rows } = await tx.query<{ id: string }>("SELECT id FROM employees WHERE role = 'HR' ORDER BY id");
  for (const hr of rows) await notifyEmployee(tx, hr.id, type, entityId, now);
}
