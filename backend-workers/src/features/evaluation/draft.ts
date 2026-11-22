import type { Queryable } from '../../db';
import { ConcurrencyError, StateConflictError } from '../../domain/errors';
import type { DraftInput } from '../../domain/evaluation';
import { sqlState } from '../../db';
import type { EvaluableTraining } from './access';

/**
 * The shared draft of a final evaluation (R27 stage S2.2; AD-66, AD-68 G5, AD-69 and the owner decisions of 2026-11-22,
 * AD-70). One draft per training application, created by its first successful save, edited by the training's current
 * evaluators. A save is one transaction (the caller's, audited as the signed-in user), in this order:
 *  1. the caller has re-read the evaluator's rights and the training inside the transaction;
 *  2. the draft row is created if missing (ON CONFLICT: two first saves create one row);
 *  3. the row is locked (FOR UPDATE): a submitted evaluation is refused (409 evaluation.already_submitted), a revision
 *     other than the stored one too (409 conflict.concurrent_update): nothing is written for a stale form;
 *  4. every criterion in the request must be active now (409 evaluation.criteria_changed);
 *  5. the scores are inserted or changed, never cleared, and an unchanged score is not rewritten (no audit row);
 *  6. the comment, recommendation, change counter and last-saved time are updated.
 * Any refusal or error rolls the whole transaction back, the created row included. The database guards (migration
 * EvaluationWriteGuards) back this up for every role.
 */

/** The database guards that mean "already submitted" (a save that raced a submission). */
const SUBMITTED_GUARDS = new Set(['evaluations_submitted_readonly', 'evaluation_scores_submitted_readonly']);

export const alreadySubmitted = () =>
  new StateConflictError('evaluation.already_submitted', 'The final evaluation has already been submitted.');

export async function saveDraft(
  tx: Queryable,
  training: EvaluableTraining,
  input: DraftInput,
  now: Date,
): Promise<void> {
  try {
    await tx.query(
      `INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'Draft', $4, $4) ON CONFLICT (application_id) DO NOTHING`,
      [crypto.randomUUID(), training.application_id, training.assignment_id, now],
    );
    const { rows } = await tx.query<{ id: string; status: string; version: number }>(
      'SELECT id, status, version FROM evaluations WHERE application_id = $1 FOR UPDATE',
      [training.application_id],
    );
    const evaluation = rows[0]!;
    if (evaluation.status !== 'Draft') throw alreadySubmitted();
    if (evaluation.version !== input.revision) throw new ConcurrencyError();

    if (input.scores.size > 0) {
      const criteria = [...input.scores.keys()];
      const { rows: active } = await tx.query<{ id: string }>(
        'SELECT id FROM evaluation_criteria WHERE is_active AND id = ANY($1::uuid[])',
        [criteria],
      );
      if (active.length !== criteria.length) {
        throw new StateConflictError(
          'evaluation.criteria_changed',
          'The evaluation criteria have changed. Reload the evaluation and try again.',
        );
      }
      await tx.query(
        `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score)
         SELECT s.id, $1, s.criterion_id, s.score
           FROM unnest($2::uuid[], $3::uuid[], $4::smallint[]) AS s(id, criterion_id, score)
         ON CONFLICT (evaluation_id, criterion_id) DO UPDATE SET score = EXCLUDED.score
          WHERE evaluation_scores.score IS DISTINCT FROM EXCLUDED.score`,
        [evaluation.id, criteria.map(() => crypto.randomUUID()), criteria, [...input.scores.values()]],
      );
    }

    await tx.query(
      `UPDATE evaluations SET comment = $2, hiring_recommendation = $3, version = version + 1, updated_at = $4
        WHERE id = $1 AND status = 'Draft'`,
      [evaluation.id, input.comment, input.hiringRecommendation, now],
    );
  } catch (error) {
    // A database guard that means "submitted" becomes the same 409; any other guard or error stays an error (500).
    const constraint = (error as { constraint?: string } | null)?.constraint;
    if (sqlState(error) === '23001' && constraint !== undefined && SUBMITTED_GUARDS.has(constraint)) {
      throw alreadySubmitted();
    }
    throw error;
  }
}

export interface DraftView {
  revision: number;
  draft: {
    comment: string | null;
    hiringRecommendation: string | null;
    /** Active criteria with a saved score only; a criterion never scored is absent. */
    scores: Record<string, number>;
    /** When the draft was last saved; never who saved it. Null before the first save. */
    lastSavedAt: Date | null;
  };
}

/** The draft as its evaluators see it (not started: revision 0, empty). Never for a submitted evaluation. */
export async function readDraft(q: Queryable, evaluationId: string | null): Promise<DraftView> {
  if (evaluationId === null) {
    return { revision: 0, draft: { comment: null, hiringRecommendation: null, scores: {}, lastSavedAt: null } };
  }
  const { rows } = await q.query<{
    version: number;
    comment: string | null;
    hiring_recommendation: string | null;
    updated_at: Date;
    scores: Record<string, number> | null;
  }>(
    `SELECT e.version, e.comment, e.hiring_recommendation, e.updated_at,
            (SELECT jsonb_object_agg(s.criterion_id, s.score ORDER BY c.sort_order)
               FROM evaluation_scores s JOIN evaluation_criteria c ON c.id = s.criterion_id
              WHERE s.evaluation_id = e.id AND c.is_active AND s.score IS NOT NULL) AS scores
       FROM evaluations e WHERE e.id = $1`,
    [evaluationId],
  );
  const row = rows[0]!;
  return {
    revision: row.version,
    draft: {
      comment: row.comment,
      hiringRecommendation: row.hiring_recommendation,
      scores: row.scores ?? {},
      lastSavedAt: row.updated_at,
    },
  };
}
