import type { Queryable } from '../../db';

/**
 * The responsible HR of an accepted application (AD-64, owner 2026-11-13). It is the HR member who accepted the
 * application (`training_applications.decided_by_id`, never changed) until an Admin appoints a replacement; each
 * appointment is a row of the insert-only `responsible_hr_changes`, and the one with the highest `sequence` is the
 * current one. One rule, read in one place: no copy of the current holder is stored anywhere else.
 *
 * `a` is the training_applications alias.
 */
export const CURRENT_RESPONSIBLE_HR_ID = `coalesce(
  (SELECT r.hr_id FROM responsible_hr_changes r WHERE r.application_id = a.id ORDER BY r.sequence DESC LIMIT 1),
  a.decided_by_id)`;

export interface ResponsibleHrRecipient {
  id: string;
  email: string;
}

/**
 * The current responsible HR of an accepted application when that user is eligible, that is when they hold the HR role
 * now; otherwise null (a former HR user is never notified, and nobody else is chosen in their place: rule 7).
 */
export async function eligibleResponsibleHr(
  q: Queryable,
  applicationId: string,
): Promise<ResponsibleHrRecipient | null> {
  const { rows } = await q.query<ResponsibleHrRecipient>(
    `SELECT e.id, e.email
       FROM training_applications a JOIN employees e ON e.id = ${CURRENT_RESPONSIBLE_HR_ID}
      WHERE a.id = $1 AND a.status = 'Accepted' AND e.role = 'HR'`,
    [applicationId],
  );
  return rows[0] ?? null;
}
