import type { SessionUser } from '../../context';
import type { Queryable } from '../../db';

/**
 * PDF §4: the available trainees are those "accepted and not yet assigned": HR accepted the application and no
 * assignment exists for it. Mentor requests do not change this, and an assignment that ended does not make the
 * trainee available again (what happens then is not defined yet). `a` is the training_applications alias.
 */
export const IS_AVAILABLE = `a.status = 'Accepted'
  AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id)`;

/**
 * An employee may open the CV of an available trainee (owner decision 2026-10-29), and keeps that access for a
 * trainee they asked to train (request waiting for HR) or were assigned. `$2` is the employee.
 */
export const EMPLOYEE_MAY_SEE_CV = `(${IS_AVAILABLE}
  OR EXISTS (SELECT 1 FROM mentor_requests r WHERE r.application_id = a.id AND r.employee_id = $2 AND r.status = 'Pending')
  OR EXISTS (SELECT 1 FROM assignments s WHERE s.application_id = a.id AND s.employee_id = $2))`;

export interface AttachmentRow {
  id: string;
  application_id: string;
  kind: 'Cv' | 'UniversityLetter';
  file_name: string;
  content_type: string;
  size_bytes: string;
  storage_key: string;
}

/**
 * The attachment `user` may read, or null (PDF §9: a trainee reaches only their own data; owner decision 2026-10-29):
 * - a trainee: the files of their own applications;
 * - HR: the files of any application (review and management);
 * - an employee: only a CV, of an available trainee, or of one they asked to train or were assigned;
 * - anyone else (Admin, an ordinary Google user): nothing.
 */
export async function readableAttachment(
  db: Queryable,
  user: SessionUser,
  attachmentId: string,
): Promise<AttachmentRow | null> {
  const select = `SELECT f.id, f.application_id, f.kind, f.file_name, f.content_type, f.size_bytes::text, f.storage_key
                    FROM application_attachments f JOIN training_applications a ON a.id = f.application_id
                   WHERE f.id = $1`;
  let rows: AttachmentRow[] = [];
  if (user.role === 'Trainee') {
    ({ rows } = await db.query<AttachmentRow>(`${select} AND a.trainee_id = $2`, [attachmentId, user.id]));
  } else if (user.role === 'HR') {
    ({ rows } = await db.query<AttachmentRow>(select, [attachmentId]));
  } else if (user.role === 'Employee') {
    ({ rows } = await db.query<AttachmentRow>(`${select} AND f.kind = 'Cv' AND ${EMPLOYEE_MAY_SEE_CV}`, [
      attachmentId,
      user.id,
    ]));
  }

  return rows[0] ?? null;
}
