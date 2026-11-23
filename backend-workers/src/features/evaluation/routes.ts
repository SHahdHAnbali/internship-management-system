import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import type { Queryable } from '../../db';
import { NotFoundError, StateConflictError } from '../../domain/errors';
import { correctionInput, criteriaVersion, draftInput, submitInput, verbalGrade } from '../../domain/evaluation';
import { bindJson, type RequestSchema } from '../../http/body';
import { statusProblem, json } from '../../http/problems';
import type { Route } from '../../http/routes';
import {
  capacities,
  EVALUATOR_ROLES,
  EvaluatorRoleError,
  evaluableTrainings,
  type EvaluableTraining,
  isAvailable,
  lockedEvaluator,
} from './access';
import { CorrectorRoleError, correctEvaluation, correctionRefusal, notSubmitted, readCorrectable } from './correct';
import { readDraft, saveDraft } from './draft';
import { submitEvaluation } from './submit';

/**
 * The final evaluation, stage S2.1 (R27; AD-66, AD-68; owner decisions of 2026-11-22): read-only.
 *
 * `GET /api/evaluations`: the ended trainings (Completed or EndedEarly) the signed-in user evaluates, with the evaluation
 * status. `GET /api/evaluations/:id` (`:id` = the training application): the training and the criteria the evaluation
 * uses: the active criteria while not submitted, the frozen snapshot once submitted; none means comment-only.
 *
 * Employee and HR only, checked here (a route policy names one role): the Admin is refused even as the final mentor
 * (G2), the trainee too (403). Anyone else gets the same 404 as for a training that does not exist (G4: nothing about
 * the evaluation, not even that it exists); an evaluator of a training not ended yet (or Withdrawn) gets 409.
 * Every response is built field by field: never an average (G8), and of the trainee only the name.
 *
 * Stage S2.2 (owner decisions of 2026-11-22, AD-70): while not submitted, the detail also carries the shared draft
 * (`revision`, comment, recommendation, the saved scores of the active criteria, and the last-saved time, never who
 * saved), and `PUT /api/evaluations/:id/draft` saves it (`draft.ts`).
 *
 * Stage S2.3 (owner decisions of 2026-11-23, AD-71): while not submitted, the detail also carries `criteriaVersion`, the
 * fingerprint of the active criteria shown, and `POST /api/evaluations/:id/submit` submits the saved draft
 * (`submit.ts`). Once submitted, the detail carries `submission` instead of the draft: the frozen scores, the comment,
 * the recommendation, the submitter's name (from the staff record), the submission time and the verbal grade from the
 * frozen scores (none for a comment-only evaluation). The list never carries a grade.
 *
 * Stage S2.4 (owner decisions of 2026-11-23, AD-72): `GET /api/evaluations/:id/correction` gives the correction page its
 * starting values (the frozen criteria, the current scores, comment, recommendation and `revision`), and
 * `POST /api/evaluations/:id/corrections` corrects the submitted evaluation at once (`correct.ts`). The submission then
 * also carries `latestCorrection`: when, by whom (name only) and why, of the latest correction only; never an id, an
 * earlier correction or an old value.
 */
const NOT_FOUND = 'The evaluation was not found.';

const status = (t: EvaluableTraining) => t.evaluation_status ?? 'NotStarted';

const summary = (t: EvaluableTraining) => ({
  applicationId: t.application_id,
  traineeName: t.trainee_name,
  fieldName: t.field_name,
  endStatus: t.end_status,
  endDate: t.end_date,
  capacities: capacities(t),
  status: status(t),
});

interface CriterionRow {
  id: string;
  name_ar: string;
  name_en: string;
  sort_order: number;
}

/** The training the user evaluates, ended: 404 when they are not its evaluator (or it does not exist), else 409. */
async function availableTraining(
  q: Queryable,
  user: Parameters<typeof evaluableTrainings>[1],
  applicationId: string,
): Promise<EvaluableTraining> {
  const [training] = await evaluableTrainings(q, user, applicationId);
  if (!training) throw new NotFoundError(NOT_FOUND);
  if (!isAvailable(training)) {
    throw new StateConflictError(
      'evaluation.not_available',
      'The final evaluation is available only after HR ends the training as Completed or Ended early.',
    );
  }
  return training;
}

/** The detail: the training and its criteria, then the shared draft, or the submission once submitted. */
async function detail(q: Queryable, training: EvaluableTraining) {
  const submitted = training.evaluation_status === 'Submitted';
  const { rows: criteria } = await q.query<CriterionRow>(
    submitted
      ? `SELECT criterion_id AS id, frozen_name_ar AS name_ar, frozen_name_en AS name_en, frozen_sort_order AS sort_order
           FROM evaluation_scores WHERE evaluation_id = $1 AND frozen_sort_order IS NOT NULL
          ORDER BY frozen_sort_order`
      : 'SELECT id, name_ar, name_en, sort_order FROM evaluation_criteria WHERE is_active ORDER BY sort_order',
    submitted ? [training.evaluation_id] : [],
  );
  return {
    ...summary(training),
    startDate: training.start_date,
    commentOnly: criteria.length === 0,
    criteria: criteria.map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, sortOrder: r.sort_order })),
    ...(submitted
      ? { submission: await readSubmission(q, training.evaluation_id!) }
      : {
          ...(await readDraft(q, training.evaluation_id)),
          criteriaVersion: await criteriaVersion(
            criteria.map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, sortOrder: r.sort_order })),
          ),
        }),
  };
}

/**
 * A submitted evaluation as its evaluators see it (AD-71): the frozen scores only (a score of a criterion that was not
 * active at submission is not part of it), the comment, the recommendation, who submitted (the staff record's name) and
 * when, and the verbal grade from the frozen scores. The total and count stay here: no mean leaves this function.
 */
async function readSubmission(q: Queryable, evaluationId: string) {
  const latestCorrection = await readLatestCorrection(q, evaluationId);
  const { rows } = await q.query<{
    submitted_at: Date;
    submitter_name: string;
    comment: string;
    hiring_recommendation: string;
    scores: Record<string, number> | null;
    total: number | null;
    scored: number;
  }>(
    `SELECT e.submitted_at, m.full_name AS submitter_name, e.comment, e.hiring_recommendation,
            (SELECT jsonb_object_agg(s.criterion_id, s.score ORDER BY s.frozen_sort_order)
               FROM evaluation_scores s WHERE s.evaluation_id = e.id AND s.frozen_sort_order IS NOT NULL) AS scores,
            (SELECT sum(s.score)::int FROM evaluation_scores s
              WHERE s.evaluation_id = e.id AND s.frozen_sort_order IS NOT NULL) AS total,
            (SELECT count(*)::int FROM evaluation_scores s
              WHERE s.evaluation_id = e.id AND s.frozen_sort_order IS NOT NULL) AS scored
       FROM evaluations e JOIN employees m ON m.id = e.submitted_by_id
      WHERE e.id = $1 AND e.status = 'Submitted'`,
    [evaluationId],
  );
  const row = rows[0]!;
  return {
    submittedAt: row.submitted_at,
    submittedBy: { name: row.submitter_name },
    comment: row.comment,
    hiringRecommendation: row.hiring_recommendation,
    scores: row.scores ?? {},
    grade: verbalGrade(row.total ?? 0, row.scored),
    latestCorrection,
  };
}

/**
 * The latest correction (AD-72): the one whose audited INSERT is the latest (`audit_logs.id`, in commit-safe order under
 * the evaluation's row lock; never the correction time, which two corrections can share). Its time, the corrector's name
 * (the staff record) and the reason only.
 */
async function readLatestCorrection(q: Queryable, evaluationId: string) {
  const { rows } = await q.query<{ corrected_at: Date; corrector_name: string; reason: string | null }>(
    `SELECT c.corrected_at, m.full_name AS corrector_name, c.reason
       FROM evaluation_corrections c
       JOIN audit_logs a ON a.table_name = 'evaluation_corrections' AND a.entity_id = c.id::text AND a.operation = 'INSERT'
       JOIN employees m ON m.id = c.corrected_by_id
      WHERE c.evaluation_id = $1
      ORDER BY a.id DESC LIMIT 1`,
    [evaluationId],
  );
  const row = rows[0];
  return row ? { correctedAt: row.corrected_at, correctedBy: { name: row.corrector_name }, reason: row.reason } : null;
}

interface DraftRequest {
  revision: number;
  comment: string | null;
  hiringRecommendation: string | null;
  scores: Record<string, unknown> | null;
}

const draftRequest: RequestSchema = {
  typeName: 'Ims.Workers.Evaluations.SaveDraftRequest',
  rejectUnmapped: true,
  properties: [
    { name: 'Revision', kind: 'int' },
    { name: 'Comment', kind: 'string' },
    { name: 'HiringRecommendation', kind: 'string' },
    { name: 'Scores', kind: 'object' },
  ],
};

interface SubmitRequest {
  revision: number;
  criteriaVersion: string | null;
}

/** Only what the evaluator saw: the draft's revision and the criteria's fingerprint (no content, submitter or grade). */
const submitRequest: RequestSchema = {
  typeName: 'Ims.Workers.Evaluations.SubmitEvaluationRequest',
  rejectUnmapped: true,
  properties: [
    { name: 'Revision', kind: 'int' },
    { name: 'CriteriaVersion', kind: 'string' },
  ],
};

interface CorrectionRequest {
  revision: number;
  comment: string | null;
  hiringRecommendation: string | null;
  scores: Record<string, unknown> | null;
  reason: string | null;
}

/** The corrected values in full (frozen scores, comment, recommendation), the revision seen and an optional reason. */
const correctionRequest: RequestSchema = {
  typeName: 'Ims.Workers.Evaluations.CorrectEvaluationRequest',
  rejectUnmapped: true,
  properties: [
    { name: 'Revision', kind: 'int' },
    { name: 'Comment', kind: 'string' },
    { name: 'HiringRecommendation', kind: 'string' },
    { name: 'Scores', kind: 'object' },
    { name: 'Reason', kind: 'string' },
  ],
};

/** The (lower-case) names of the fields a JSON object body contains: a missing field is never read as "clear". */
async function presentFields(request: Request): Promise<string[]> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).map((k) => k.toLowerCase())
      : [];
  } catch {
    return []; // the binder reports the malformed body
  }
}

/** The evaluator roles may read; anyone else is refused for the whole endpoint (no record is looked at). */
function evaluator(c: Context<AppEnv>) {
  const user = c.var.user!;
  return user.role !== null && EVALUATOR_ROLES.includes(user.role) ? user : null;
}

export const evaluationRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/evaluations',
    policy: 'authenticated',
    async handle(c) {
      const user = evaluator(c);
      if (!user) return statusProblem(403, c.var.traceId, true);
      const trainings = await evaluableTrainings(c.var.db, user, null);
      return json(trainings.filter(isAvailable).map(summary));
    },
  },
  {
    method: 'GET',
    path: '/api/evaluations/:id',
    policy: 'authenticated',
    async handle(c) {
      const user = evaluator(c);
      if (!user) return statusProblem(403, c.var.traceId, true);
      return json(await detail(c.var.db, await availableTraining(c.var.db, user, c.req.param('id')!)));
    },
  },
  {
    method: 'PUT',
    path: '/api/evaluations/:id/draft',
    policy: 'authenticated',
    async handle(c) {
      const user = evaluator(c);
      if (!user) return statusProblem(403, c.var.traceId, true);
      const present = await presentFields(c.req.raw.clone());
      const body = await bindJson<DraftRequest>(c.req.raw, draftRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const input = draftInput(body.value, present);

      const applicationId = c.req.param('id')!;
      try {
        const result = await c.var.db.transaction(c.var.actor, async (tx) => {
          // The evaluator's rights are decided inside the transaction that writes, under locks held until it commits.
          const rights = await lockedEvaluator(tx, applicationId, user, availableTraining);
          await saveDraft(tx, rights.training, input, c.var.deps.now());
          return detail(tx, await availableTraining(tx, rights.user, applicationId));
        });
        return json(result);
      } catch (error) {
        // The role became one that may not evaluate (Admin) while the request waited: 403, as before the transaction.
        if (error instanceof EvaluatorRoleError) return statusProblem(403, c.var.traceId, true);
        throw error;
      }
    },
  },
  {
    method: 'POST',
    path: '/api/evaluations/:id/submit',
    policy: 'authenticated',
    async handle(c) {
      const user = evaluator(c);
      if (!user) return statusProblem(403, c.var.traceId, true);
      const present = await presentFields(c.req.raw.clone());
      const body = await bindJson<SubmitRequest>(c.req.raw, submitRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const input = submitInput(body.value, present);

      const applicationId = c.req.param('id')!;
      try {
        const result = await c.var.db.transaction(c.var.actor, async (tx) => {
          // The evaluator's rights are decided inside the transaction that submits, under locks held until it commits.
          const rights = await lockedEvaluator(tx, applicationId, user, availableTraining);
          await submitEvaluation(tx, rights.training, user.id, input, c.var.deps.now());
          return detail(tx, await availableTraining(tx, rights.user, applicationId));
        });
        return json(result);
      } catch (error) {
        if (error instanceof EvaluatorRoleError) return statusProblem(403, c.var.traceId, true);
        throw error;
      }
    },
  },
  {
    method: 'GET',
    path: '/api/evaluations/:id/correction',
    policy: 'authenticated',
    async handle(c) {
      const user = evaluator(c);
      if (!user) return statusProblem(403, c.var.traceId, true);
      const training = await availableTraining(c.var.db, user, c.req.param('id')!);
      const current = training.evaluation_id === null ? null : await readCorrectable(c.var.db, training.evaluation_id);
      if (!current) throw notSubmitted();
      const { criteria } = await detail(c.var.db, training);
      return json({
        ...summary(training),
        startDate: training.start_date,
        commentOnly: criteria.length === 0,
        criteria,
        ...current,
      });
    },
  },
  {
    method: 'POST',
    path: '/api/evaluations/:id/corrections',
    policy: 'authenticated',
    async handle(c) {
      const user = evaluator(c);
      if (!user) return statusProblem(403, c.var.traceId, true);
      const present = await presentFields(c.req.raw.clone());
      const body = await bindJson<CorrectionRequest>(c.req.raw, correctionRequest, c.var.traceId);
      if (!body.ok) return body.response;
      const input = correctionInput(body.value, present);

      const applicationId = c.req.param('id')!;
      try {
        const result = await c.var.db.transaction(c.var.actor, async (tx) =>
          // The corrector's rights and the training are decided inside the transaction, under the locks that keep them
          // until it commits (application, evaluation, staff row: correct.ts).
          detail(tx, await correctEvaluation(tx, applicationId, user, input, c.var.deps.now(), availableTraining)),
        );
        return json(result);
      } catch (error) {
        // The role became one that may not correct (Admin) while the request waited: 403, as before the transaction.
        if (error instanceof CorrectorRoleError) return statusProblem(403, c.var.traceId, true);
        throw correctionRefusal(error); // a refusal at COMMIT (H2) is the same 409
      }
    },
  },
];
