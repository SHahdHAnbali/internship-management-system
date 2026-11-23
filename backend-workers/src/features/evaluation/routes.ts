import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import type { Queryable } from '../../db';
import { NotFoundError, StateConflictError } from '../../domain/errors';
import { criteriaVersion, draftInput, submitInput, verbalGrade } from '../../domain/evaluation';
import { bindJson, type RequestSchema } from '../../http/body';
import { statusProblem, json } from '../../http/problems';
import type { Route } from '../../http/routes';
import { capacities, EVALUATOR_ROLES, evaluableTrainings, type EvaluableTraining, isAvailable } from './access';
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
  };
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
      const result = await c.var.db.transaction(c.var.actor, async (tx) => {
        // The evaluator's rights and the training are read again inside the transaction that writes.
        await saveDraft(tx, await availableTraining(tx, user, applicationId), input, c.var.deps.now());
        return detail(tx, await availableTraining(tx, user, applicationId));
      });
      return json(result);
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
      const result = await c.var.db.transaction(c.var.actor, async (tx) => {
        // The evaluator's rights and the training are read again inside the transaction that submits.
        await submitEvaluation(tx, await availableTraining(tx, user, applicationId), user.id, input, c.var.deps.now());
        return detail(tx, await availableTraining(tx, user, applicationId));
      });
      return json(result);
    },
  },
];
