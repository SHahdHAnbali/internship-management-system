import type { Queryable } from '../../db';
import type { UserRole } from '../../domain/roles';
import { CURRENT_RESPONSIBLE_HR_ID } from '../training/responsibleHr';

/**
 * Who may see a training's final evaluation (R27; AD-66, AD-68 G2 and G4; owner decisions of 2026-11-22), in one rule
 * read in one query, at every request (roles and responsible HR are read from the database each time, AD-33):
 * - the **final mentor**: the mentor of the training's latest assignment (nothing was transferred out of it, AD-65),
 *   while they hold the Employee or HR role (the Admin never evaluates, G2: the caller refuses that role first);
 * - the **current responsible HR** (AD-64), while they hold the HR role.
 * A previous mentor, a former responsible HR, an HR user who lost the role and anyone else is not an evaluator.
 *
 * The evaluation is **available** once HR ended that latest assignment as Completed or EndedEarly (AD-63 D1); a
 * Withdrawn or still Active training, or one never assigned, has none yet. `a` is training_applications.
 */
export const EVALUATOR_ROLES: readonly UserRole[] = ['Employee', 'HR'];
export const AVAILABLE_END_STATUSES = ['Completed', 'EndedEarly'] as const;

export type Capacity = 'FinalMentor' | 'ResponsibleHr';

export interface EvaluableTraining {
  application_id: string;
  trainee_name: string | null;
  field_name: string;
  start_date: string | null;
  /** The latest assignment (the one a draft is recorded against), its status and end date (the actual end once ended). */
  assignment_id: string | null;
  end_status: string | null;
  end_date: string | null;
  final_mentor: boolean;
  responsible_hr: boolean;
  evaluation_id: string | null;
  evaluation_status: 'Draft' | 'Submitted' | null;
}

/**
 * The trainings the user may evaluate (or `applicationId` only), ended or not: the caller decides what an unavailable one
 * means. Only the columns the read-only views need are read: no trainee contact data, no evaluation content.
 */
export async function evaluableTrainings(
  q: Queryable,
  user: { id: string; role: UserRole | null },
  applicationId: string | null,
): Promise<EvaluableTraining[]> {
  const { rows } = await q.query<EvaluableTraining>(
    `SELECT a.id AS application_id, t.full_name AS trainee_name, f.name AS field_name,
            (SELECT min(p.start_date) FROM assignments p WHERE p.application_id = a.id)::text AS start_date,
            s.id AS assignment_id, s.status AS end_status, s.end_date::text AS end_date,
            coalesce(s.employee_id = $1, false) AS final_mentor,
            ($2 = 'HR' AND ${CURRENT_RESPONSIBLE_HR_ID} = $1) AS responsible_hr,
            ev.id AS evaluation_id, ev.status AS evaluation_status
       FROM training_applications a
       JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
       LEFT JOIN LATERAL (
              SELECT s.id, s.employee_id, s.status, s.end_date FROM assignments s
               WHERE s.application_id = a.id
                 AND NOT EXISTS (SELECT 1 FROM assignment_transfers x WHERE x.from_assignment_id = s.id)
               ORDER BY s.created_at DESC, s.id DESC LIMIT 1) s ON true
       LEFT JOIN evaluations ev ON ev.application_id = a.id
      WHERE a.status = 'Accepted'
        AND (s.employee_id = $1 OR ($2 = 'HR' AND ${CURRENT_RESPONSIBLE_HR_ID} = $1))
        AND ($3::uuid IS NULL OR a.id = $3)
      ORDER BY s.end_date DESC NULLS LAST, a.id`,
    [user.id, user.role, applicationId],
  );
  return rows;
}

export function isAvailable(training: EvaluableTraining): boolean {
  return (AVAILABLE_END_STATUSES as readonly (string | null)[]).includes(training.end_status);
}

export function capacities(training: EvaluableTraining): Capacity[] {
  return [
    ...(training.final_mentor ? (['FinalMentor'] as const) : []),
    ...(training.responsible_hr ? (['ResponsibleHr'] as const) : []),
  ];
}

/**
 * Writes to an evaluation (the S2.2 draft save, the S2.3 submission) decide the rights under locks held until COMMIT
 * (owner decisions of 2026-11-23: solution C, the S2.4 locking applied to S2.2 and S2.3), in the caller's transaction:
 *  1. the training application row FOR SHARE: an Admin's replacement of the responsible HR (FOR NO KEY UPDATE on it)
 *     waits for the write, or the write waits for it and then sees it. The row always exists, also before the first draft;
 *  2. the actor's staff row FOR SHARE: a role change (FOR NO KEY UPDATE, then UPDATE) waits likewise;
 *  3. the rights from that locked state, never from the role read when the request started: a role other than Employee
 *     or HR → `EvaluatorRoleError` (403); no longer the final mentor or the responsible HR → 404; not ended → 409.
 * Only then does the caller write (the draft's INSERT and row lock; the submission's row lock and criteria table lock), so
 * a refused actor writes nothing. Both locks come before any evaluation lock, in the project's order (the application
 * first, the staff row after it, features/training/transfers.ts). S2.4 corrections keep their own locking (correct.ts).
 */
export class EvaluatorRoleError extends Error {
  constructor() {
    super('The signed-in user may not evaluate.');
    this.name = 'EvaluatorRoleError';
  }
}

/** Decides the rights for the application with the given (locked) role: 404 not an evaluator, 409 not ended. */
export type TrainingResolver = (
  q: Queryable,
  user: { id: string; role: UserRole | null },
  applicationId: string,
) => Promise<EvaluableTraining>;

export async function lockedEvaluator(
  tx: Queryable,
  applicationId: string,
  actor: { id: string; role: UserRole | null },
  resolve: TrainingResolver,
): Promise<{ training: EvaluableTraining; user: { id: string; role: UserRole } }> {
  await tx.query('SELECT id FROM training_applications WHERE id = $1 FOR SHARE', [applicationId]);
  const { rows } = await tx.query<{ role: string }>('SELECT role FROM employees WHERE id = $1 FOR SHARE', [actor.id]);
  const role = rows[0]?.role as UserRole | undefined;
  if (role === undefined || !EVALUATOR_ROLES.includes(role)) throw new EvaluatorRoleError();
  const user = { ...actor, role };
  return { training: await resolve(tx, user, applicationId), user };
}
