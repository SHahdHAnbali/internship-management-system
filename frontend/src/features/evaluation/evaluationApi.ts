import { apiRequest } from '../../lib/api';
import type { EvaluationDetail, EvaluationSummary, SaveDraftRequest } from './models';

/** The evaluators' final evaluation API (Employee and HR; the Admin and trainees are refused). */
export const evaluationApi = {
  list: () => apiRequest<EvaluationSummary[]>('GET', '/evaluations'),
  get: (applicationId: string) =>
    apiRequest<EvaluationDetail>('GET', `/evaluations/${encodeURIComponent(applicationId)}`),
  /** Saves the shared draft (S2.2); answers with the evaluation as `get` does. */
  saveDraft: (applicationId: string, draft: SaveDraftRequest) =>
    apiRequest<EvaluationDetail>(
      'PUT',
      `/evaluations/${encodeURIComponent(applicationId)}/draft`,
      draft,
    ),
};
