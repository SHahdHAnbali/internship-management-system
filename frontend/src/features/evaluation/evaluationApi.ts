import { apiRequest } from '../../lib/api';
import type { EvaluationDetail, EvaluationSummary } from './models';

/** The evaluators' read-only final evaluation API (Employee and HR; the Admin and trainees are refused). */
export const evaluationApi = {
  list: () => apiRequest<EvaluationSummary[]>('GET', '/evaluations'),
  get: (applicationId: string) =>
    apiRequest<EvaluationDetail>('GET', `/evaluations/${encodeURIComponent(applicationId)}`),
};
