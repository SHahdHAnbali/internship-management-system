import { describe, expect, it } from 'vitest';
import type { Queryable } from '../src/db';
import { StateConflictError } from '../src/domain/errors';
import { draftInput } from '../src/domain/evaluation';
import type { EvaluableTraining } from '../src/features/evaluation/access';
import { saveDraft } from '../src/features/evaluation/draft';

/**
 * How a save reports the database write guards (migration EvaluationWriteGuards; S2.2, K1 option B). The API checks the
 * status under the row lock first, so a guard should never fire; if one does, only "already submitted" guards become the
 * usual 409, and anything else stays an error (never hidden, never a success). The PostgreSQL error is reproduced with
 * its real shape (SQLSTATE in `code`, the guard's name in `constraint`), as the least-privilege tests show it is raised.
 */
const C = '01a1cccc-0000-7000-8000-000000000001';
const training = {
  application_id: '01a1aaaa-0000-7000-8000-000000000001',
  assignment_id: '01a1bbbb-0000-7000-8000-000000000001',
  evaluation_id: null,
} as EvaluableTraining;
const input = draftInput({ revision: 0, comment: null, hiringRecommendation: null, scores: { [C]: 3 } }, [
  'revision',
  'comment',
  'hiringrecommendation',
  'scores',
]);

/** A transaction whose score write fails with `error`; every earlier statement succeeds as for a new draft. */
function failingAtScores(error: object): Queryable {
  return {
    async query(sql: string) {
      if (sql.includes('INSERT INTO evaluation_scores')) throw Object.assign(new Error('database message'), error);
      if (sql.includes('FOR UPDATE')) return { rows: [{ id: 'e', status: 'Draft', version: 0 }], rowCount: 1 };
      if (sql.includes('evaluation_criteria')) return { rows: [{ id: C }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable;
}

describe('saveDraft and the database guards', () => {
  it.each(['evaluation_scores_submitted_readonly', 'evaluations_submitted_readonly'])(
    'reports %s as 409 evaluation.already_submitted',
    async (constraint) => {
      const error = await saveDraft(failingAtScores({ code: '23001', constraint }), training, input, new Date()).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(StateConflictError);
      expect((error as StateConflictError).code).toBe('evaluation.already_submitted');
    },
  );

  it.each([
    ['another guard', { code: '23001', constraint: 'evaluation_scores_not_cleared' }],
    ['the no-delete guard', { code: '23001' }],
    ['a check constraint', { code: '23514', constraint: 'ck_evaluation_scores_score' }],
    ['a lost connection', { code: '08006' }],
  ])('lets %s through unchanged (an error, never a success)', async (_label, shape) => {
    const error = await saveDraft(failingAtScores(shape), training, input, new Date()).catch((e) => e);
    expect(error).not.toBeInstanceOf(StateConflictError);
    expect(error).toMatchObject(shape);
  });
});
