/**
 * The final evaluation as its evaluators see it in stage S2.1 (R27; AD-66, AD-68): read-only. Scores, the comment, the
 * hiring recommendation and the verbal grade come in later stages; a numeric average never exists here (G8).
 */
export type EvaluationCapacity = 'FinalMentor' | 'ResponsibleHr';
export type EvaluationStatus = 'NotStarted' | 'Draft' | 'Submitted';

/** An ended training the signed-in user evaluates (as its final mentor, its current responsible HR, or both). */
export interface EvaluationSummary {
  applicationId: string;
  /** Null until the trainee enters a name. */
  traineeName: string | null;
  fieldName: string;
  endStatus: 'Completed' | 'EndedEarly';
  endDate: string;
  capacities: EvaluationCapacity[];
  status: EvaluationStatus;
}

export interface EvaluationCriterion {
  id: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
}

export type HiringRecommendation = 'Yes' | 'Maybe' | 'No';

/**
 * The shared draft (S2.2; owner decisions of 2026-11-22): only the active criteria with a saved score are in `scores`
 * (a criterion never scored is absent); `lastSavedAt` is the time only, never who saved, and null before the first save.
 */
export interface EvaluationDraft {
  comment: string | null;
  hiringRecommendation: HiringRecommendation | null;
  scores: Record<string, number>;
  lastSavedAt: string | null;
}

/** A draft save: every field; scores 1–5 only (a saved score is never cleared); criteria left out keep their values. */
export interface SaveDraftRequest {
  revision: number;
  comment: string | null;
  hiringRecommendation: HiringRecommendation | null;
  scores: Record<string, number>;
}

export interface EvaluationDetail extends EvaluationSummary {
  startDate: string;
  /** No criterion: the evaluation is a written comment only (AD-66). */
  commentOnly: boolean;
  /** The active criteria in their order; once submitted, the criteria frozen at submission. */
  criteria: EvaluationCriterion[];
  /** Not submitted (NotStarted or Draft) only: the change counter the next save must send, and the draft. */
  revision?: number;
  draft?: EvaluationDraft;
}
