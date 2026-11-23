import { sqlState, type Queryable } from '../../db';
import { ConcurrencyError, StateConflictError } from '../../domain/errors';
import { correctionDiff, type CorrectionInput, hasChanges } from '../../domain/evaluation';
import { uuidV7 } from '../../domain/uuid';
import type { UserRole } from '../../domain/roles';
import { EVALUATOR_ROLES, type EvaluableTraining } from './access';

/**
 * Correcting a submitted final evaluation (R27 stage S2.4; owner decisions of 2026-11-23, AD-72). Immediate and atomic:
 * no correction draft, no approval, no e-mail or notification. One transaction (the caller's, audited as the signed-in
 * user), in this order (owner decision of 2026-11-23, solution B: the rights are decided under the locks that keep them):
 *  1. the training application row is locked FOR SHARE: an Admin's replacement of the responsible HR (which locks it
 *     FOR NO KEY UPDATE) waits for this correction, or this correction waits for it and then sees it;
 *  2. the evaluation row is locked FOR UPDATE (two corrections, or a correction and a draft save, one at a time);
 *  3. the corrector's staff row is locked FOR SHARE: a role change (FOR NO KEY UPDATE, then UPDATE) waits likewise;
 *  4. the rights are decided from that locked state: a role other than Employee or HR → 403 (`CorrectorRoleError`);
 *     no longer the final mentor or the responsible HR → 404; the training not ended → 409 evaluation.not_available;
 *     not submitted → 409 evaluation.not_submitted; another revision → 409 conflict.concurrent_update;
 *  The locks follow the project's order (the application first, the staff row last; features/training/transfers.ts).
 *  5. the request is checked against the frozen criteria (exactly that set) and compared with the current values;
 *  6. nothing changes (a reason alone, or the values already stored) → 409 evaluation.no_changes;
 *  7. one correction record (the signed-in corrector, the time, the optional reason);
 *  8. only the scores that change;
 *  9. the comment, the recommendation and the change counter (incremented once) in one statement.
 * The original submitter and submission time, and the frozen names and order, never change. The database guards (migration
 * EvaluationCorrections: D3+, H1, H2) back this up for every role; their refusals map to the same 409s.
 */

export const notSubmitted = () =>
  new StateConflictError('evaluation.not_submitted', 'Only a submitted final evaluation can be corrected.');

export const noChanges = () =>
  new StateConflictError(
    'evaluation.no_changes',
    'The correction does not change any score, the comment or the recommendation.',
  );

/** The corrector's current (locked) role may not correct (Admin): the caller answers 403 and rolls everything back. */
export class CorrectorRoleError extends Error {
  constructor() {
    super('The signed-in user may not correct evaluations.');
    this.name = 'CorrectorRoleError';
  }
}

/** The database refusals that mean one of the 409s above (a race the checks here did not see). */
const REFUSALS: Record<string, () => Error> = {
  evaluation_corrections_submitted_only: notSubmitted,
  evaluation_corrections_net_change: noChanges,
};

/** Maps a database refusal of a correction (also one raised at COMMIT) to its 409; anything else is rethrown. */
export function correctionRefusal(error: unknown): unknown {
  const constraint = (error as { constraint?: string } | null)?.constraint;
  return sqlState(error) === '23001' && constraint !== undefined && constraint in REFUSALS
    ? REFUSALS[constraint]!()
    : error;
}

export interface CorrectionView {
  revision: number;
  comment: string;
  hiringRecommendation: string;
  /** Frozen criterion id → current score. */
  scores: Record<string, number>;
}

/** The current values of a submitted evaluation, as the correction page starts from them. */
export async function readCorrectable(q: Queryable, evaluationId: string): Promise<CorrectionView | null> {
  const { rows } = await q.query<{ status: string; version: number; comment: string; hiring_recommendation: string }>(
    'SELECT status, version, comment, hiring_recommendation FROM evaluations WHERE id = $1',
    [evaluationId],
  );
  const row = rows[0];
  if (!row || row.status !== 'Submitted') return null;
  const { rows: scores } = await q.query<{ criterion_id: string; score: number }>(
    `SELECT criterion_id, score FROM evaluation_scores
      WHERE evaluation_id = $1 AND frozen_sort_order IS NOT NULL ORDER BY frozen_sort_order`,
    [evaluationId],
  );
  return {
    revision: row.version,
    comment: row.comment,
    hiringRecommendation: row.hiring_recommendation,
    scores: Object.fromEntries(scores.map((s) => [s.criterion_id.toLowerCase(), s.score])),
  };
}

/** Decides the corrector's rights for the application (404 not their evaluation, 409 not ended), for the given role. */
export type TrainingResolver = (
  q: Queryable,
  user: { id: string; role: UserRole | null },
  applicationId: string,
) => Promise<EvaluableTraining>;

/** Corrects the evaluation and returns the training as read under the locks (for the response). */
export async function correctEvaluation(
  tx: Queryable,
  applicationId: string,
  corrector: { id: string; role: UserRole | null },
  input: CorrectionInput,
  now: Date,
  resolveTraining: TrainingResolver,
): Promise<EvaluableTraining> {
  try {
    // 1–3: the locks, in this order, before any decision.
    await tx.query('SELECT id FROM training_applications WHERE id = $1 FOR SHARE', [applicationId]);
    const { rows: evaluations } = await tx.query<{
      id: string;
      status: string;
      version: number;
      comment: string;
      hiring_recommendation: string;
    }>(
      `SELECT id, status, version, comment, hiring_recommendation FROM evaluations
        WHERE application_id = $1 FOR UPDATE`,
      [applicationId],
    );
    const { rows: staff } = await tx.query<{ role: string }>('SELECT role FROM employees WHERE id = $1 FOR SHARE', [
      corrector.id,
    ]);

    // 4: the rights, from the locked role and the locked relationship.
    const role = staff[0]?.role as UserRole | undefined;
    if (role === undefined || !EVALUATOR_ROLES.includes(role)) throw new CorrectorRoleError();
    const training = await resolveTraining(tx, { ...corrector, role }, applicationId);
    const evaluation = evaluations[0];
    if (!evaluation || evaluation.status !== 'Submitted' || training.evaluation_id !== evaluation.id) {
      throw notSubmitted();
    }
    if (evaluation.version !== input.revision) throw new ConcurrencyError();
    const evaluationId = evaluation.id;
    const { rows: frozen } = await tx.query<{ criterion_id: string; score: number }>(
      `SELECT criterion_id, score FROM evaluation_scores
        WHERE evaluation_id = $1 AND frozen_sort_order IS NOT NULL ORDER BY frozen_sort_order`,
      [evaluationId],
    );
    const current = {
      comment: evaluation.comment,
      hiringRecommendation: evaluation.hiring_recommendation,
      scores: Object.fromEntries(frozen.map((f) => [f.criterion_id.toLowerCase(), f.score])),
    };

    const diff = correctionDiff(
      {
        comment: current.comment,
        hiringRecommendation: current.hiringRecommendation,
        scores: new Map(Object.entries(current.scores)),
      },
      input,
    );
    if (!hasChanges(diff)) throw noChanges();

    await tx.query(
      `INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidV7(now), evaluationId, corrector.id, now, input.reason], // ids are UUID v7 (docs/architecture.md)
    );

    if (diff.scores.size > 0) {
      const changed = await tx.query(
        `UPDATE evaluation_scores s SET score = c.score
           FROM unnest($2::uuid[], $3::smallint[]) AS c(criterion_id, score)
          WHERE s.evaluation_id = $1 AND s.criterion_id = c.criterion_id AND s.frozen_sort_order IS NOT NULL`,
        [evaluationId, [...diff.scores.keys()], [...diff.scores.values()]],
      );
      if (changed.rowCount !== diff.scores.size) {
        throw new Error(`The correction changed ${changed.rowCount} scores instead of ${diff.scores.size}.`);
      }
    }

    const updated = await tx.query(
      `UPDATE evaluations SET comment = $2, hiring_recommendation = $3, version = version + 1, updated_at = $4
        WHERE id = $1 AND status = 'Submitted'`,
      [evaluationId, input.comment, input.hiringRecommendation, now],
    );
    if (updated.rowCount !== 1) throw new Error('The corrected evaluation could not be updated.');
    return training;
  } catch (error) {
    throw correctionRefusal(error);
  }
}
