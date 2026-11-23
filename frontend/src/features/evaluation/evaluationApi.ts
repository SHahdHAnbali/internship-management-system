import { apiRequest } from '../../lib/api';
import type {
  CorrectEvaluationRequest,
  CorrectionStart,
  EvaluationDetail,
  EvaluationSummary,
  SaveDraftRequest,
  SubmitEvaluationRequest,
} from './models';

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
  /** Submits the saved draft (S2.3); answers with the submitted evaluation. Never retried automatically. */
  submit: (applicationId: string, request: SubmitEvaluationRequest) =>
    apiRequest<EvaluationDetail>(
      'POST',
      `/evaluations/${encodeURIComponent(applicationId)}/submit`,
      request,
    ),
  /** The correction page's starting values (S2.4). */
  correction: (applicationId: string) =>
    apiRequest<CorrectionStart>(
      'GET',
      `/evaluations/${encodeURIComponent(applicationId)}/correction`,
    ),
  /** Corrects the submitted evaluation at once (S2.4); answers with it as `get` does. Never retried automatically. */
  correct: (applicationId: string, request: CorrectEvaluationRequest) =>
    apiRequest<EvaluationDetail>(
      'POST',
      `/evaluations/${encodeURIComponent(applicationId)}/corrections`,
      request,
    ),
};
