import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { NotFoundError, StateConflictError } from '../../domain/errors';
import { statusProblem, json } from '../../http/problems';
import type { Route } from '../../http/routes';
import { capacities, EVALUATOR_ROLES, evaluableTrainings, type EvaluableTraining, isAvailable } from './access';

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
 * Every response is built field by field: no score, comment, recommendation, version, average or grade (G8; later
 * stages add their own fields with approval), and of the trainee only the name.
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
      const [training] = await evaluableTrainings(c.var.db, user, c.req.param('id')!);
      if (!training) throw new NotFoundError(NOT_FOUND);
      if (!isAvailable(training)) {
        throw new StateConflictError(
          'evaluation.not_available',
          'The final evaluation is available only after HR ends the training as Completed or Ended early.',
        );
      }

      const { rows: criteria } = await c.var.db.query<CriterionRow>(
        training.evaluation_status === 'Submitted'
          ? `SELECT criterion_id AS id, frozen_name_ar AS name_ar, frozen_name_en AS name_en, frozen_sort_order AS sort_order
               FROM evaluation_scores WHERE evaluation_id = $1 AND frozen_sort_order IS NOT NULL
              ORDER BY frozen_sort_order`
          : 'SELECT id, name_ar, name_en, sort_order FROM evaluation_criteria WHERE is_active ORDER BY sort_order',
        training.evaluation_status === 'Submitted' ? [training.evaluation_id] : [],
      );
      return json({
        ...summary(training),
        startDate: training.start_date,
        commentOnly: criteria.length === 0,
        criteria: criteria.map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, sortOrder: r.sort_order })),
      });
    },
  },
];
