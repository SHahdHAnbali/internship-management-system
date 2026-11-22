import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import type { Queryable } from '../../db';
import { NotFoundError, StateConflictError } from '../../domain/errors';
import { draftInput } from '../../domain/evaluation';
import { bindJson, type RequestSchema } from '../../http/body';
import { statusProblem, json } from '../../http/problems';
import type { Route } from '../../http/routes';
import { capacities, EVALUATOR_ROLES, evaluableTrainings, type EvaluableTraining, isAvailable } from './access';
import { readDraft, saveDraft } from './draft';

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
 * Every response is built field by field: no average or grade (G8), and of the trainee only the name.
 *
 * Stage S2.2 (owner decisions of 2026-11-22, AD-70): while not submitted, the detail also carries the shared draft
 * (`revision`, comment, recommendation, the saved scores of the active criteria, and the last-saved time, never who
 * saved), and `PUT /api/evaluations/:id/draft` saves it (`draft.ts`). A submitted evaluation stays as in S2.1.
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

/** The detail: the training and its criteria, and the shared draft unless the evaluation is submitted. */
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
    ...(submitted ? {} : await readDraft(q, training.evaluation_id)),
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
];
