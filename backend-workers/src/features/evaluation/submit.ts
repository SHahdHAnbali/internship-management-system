import { sqlState, type Queryable } from '../../db';
import { ConcurrencyError, StateConflictError } from '../../domain/errors';
import {
  criteriaVersion,
  type CriterionIdentity,
  isComplete,
  missingForSubmission,
  type SubmitInput,
} from '../../domain/evaluation';
import type { EvaluableTraining } from './access';
import { alreadySubmitted } from './draft';

/**
 * Submitting the final evaluation (R27 stage S2.3; AD-66, AD-68 G3/G8, AD-70, owner decisions of 2026-11-23, AD-71). One
 * transaction (the caller's, audited as the signed-in user), in this order:
 *  1. the caller has re-read the evaluator's rights and the training inside the transaction;
 *  2. the evaluation row is locked (FOR UPDATE): none yet → 409 evaluation.incomplete (only a saved draft is submitted);
 *     submitted → 409 evaluation.already_submitted; another revision → 409 conflict.concurrent_update;
 *  3. `LOCK TABLE evaluation_criteria IN SHARE MODE`: until commit no criterion can be created, activated, deactivated
 *     or renamed (an Admin change waits; one in progress is waited for), so the active set read next is the one frozen;
 *  4. the fingerprint of the active criteria must be the one the evaluator saw → else 409 evaluation.criteria_changed
 *     (checked before completeness: a changed set needs a review first);
 *  5. the saved draft must be complete: comment, recommendation and a score for every active criterion (with none, the
 *     comment and the recommendation still) → else 409 evaluation.incomplete;
 *  6. the snapshot (names and order) is written on exactly those score rows while the evaluation is still a Draft, from
 *     the values read under the lock; any other count rolls everything back;
 *  7. the status, the signed-in submitter, the submission time, the revision and the last change time.
 * The database guards (migration EvaluationWriteGuards) back this up for every role. No mean is computed here.
 */

const SUBMITTED_GUARDS = new Set(['evaluations_submitted_readonly', 'evaluation_scores_submitted_readonly']);

export const incomplete = () =>
  new StateConflictError(
    'evaluation.incomplete',
    'The evaluation cannot be submitted: save a draft with a comment, a hiring recommendation and a score for every criterion first.',
  );

export const criteriaChanged = () =>
  new StateConflictError(
    'evaluation.criteria_changed',
    'The evaluation criteria have changed. Reload the evaluation and review them before submitting.',
  );

export async function submitEvaluation(
  tx: Queryable,
  training: EvaluableTraining,
  submitterId: string,
  input: SubmitInput,
  now: Date,
): Promise<void> {
  try {
    const { rows } = await tx.query<{
      id: string;
      status: string;
      version: number;
      comment: string | null;
      hiring_recommendation: string | null;
    }>(
      `SELECT id, status, version, comment, hiring_recommendation FROM evaluations
        WHERE application_id = $1 FOR UPDATE`,
      [training.application_id],
    );
    const evaluation = rows[0];
    if (!evaluation) throw incomplete();
    if (evaluation.status !== 'Draft') throw alreadySubmitted();
    if (evaluation.version !== input.revision) throw new ConcurrencyError();

    await tx.query('LOCK TABLE evaluation_criteria IN SHARE MODE');
    const active = (
      await tx.query<{ id: string; name_ar: string; name_en: string; sort_order: number }>(
        'SELECT id, name_ar, name_en, sort_order FROM evaluation_criteria WHERE is_active ORDER BY sort_order',
      )
    ).rows.map((r): CriterionIdentity => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, sortOrder: r.sort_order }));
    if ((await criteriaVersion(active)) !== input.criteriaVersion) throw criteriaChanged();

    const { rows: saved } = await tx.query<{ criterion_id: string; score: number }>(
      'SELECT criterion_id, score FROM evaluation_scores WHERE evaluation_id = $1 AND score IS NOT NULL',
      [evaluation.id],
    );
    const missing = missingForSubmission(
      {
        comment: evaluation.comment,
        hiringRecommendation: evaluation.hiring_recommendation,
        scores: new Map(saved.map((s) => [s.criterion_id.toLowerCase(), s.score])),
      },
      active.map((c) => c.id),
    );
    if (!isComplete(missing)) throw incomplete();

    if (active.length > 0) {
      const frozen = await tx.query(
        `UPDATE evaluation_scores s
            SET frozen_name_ar = c.name_ar, frozen_name_en = c.name_en, frozen_sort_order = c.sort_order
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::int[]) AS c(id, name_ar, name_en, sort_order)
          WHERE s.evaluation_id = $1 AND s.criterion_id = c.id AND s.score IS NOT NULL`,
        [
          evaluation.id,
          active.map((c) => c.id),
          active.map((c) => c.nameAr),
          active.map((c) => c.nameEn),
          active.map((c) => c.sortOrder),
        ],
      );
      if (frozen.rowCount !== active.length) {
        throw new Error(`The snapshot froze ${frozen.rowCount} scores instead of ${active.length}.`);
      }
    }

    const submitted = await tx.query(
      `UPDATE evaluations
          SET status = 'Submitted', submitted_by_id = $2, submitted_at = $3, version = version + 1, updated_at = $3
        WHERE id = $1 AND status = 'Draft'`,
      [evaluation.id, submitterId, now],
    );
    if (submitted.rowCount !== 1) throw new Error('The evaluation could not be marked as submitted.');
  } catch (error) {
    // A database guard that means "submitted" becomes the same 409; any other guard or error stays an error (500).
    const constraint = (error as { constraint?: string } | null)?.constraint;
    if (sqlState(error) === '23001' && constraint !== undefined && SUBMITTED_GUARDS.has(constraint)) {
      throw alreadySubmitted();
    }
    throw error;
  }
}
