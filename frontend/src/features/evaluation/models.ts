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
  /** Not submitted only (S2.3): the fingerprint of the criteria shown, sent back on submission. */
  criteriaVersion?: string;
  /** Submitted only (S2.3): what was submitted, for its evaluators. */
  submission?: EvaluationSubmission;
}

/** The verbal grade (AD-66, AD-68 G3/G8); the numeric mean never exists outside the server. */
export type VerbalGrade = 'Excellent' | 'VeryGood' | 'Good' | 'Pass' | 'Poor';

/**
 * A submitted evaluation (S2.3; owner decisions of 2026-11-23, AD-71): the frozen scores by criterion id, the comment,
 * the recommendation, who submitted (name only) and when, and the verbal grade (none for a comment-only evaluation).
 */
export interface EvaluationSubmission {
  submittedAt: string;
  submittedBy: { name: string };
  comment: string;
  hiringRecommendation: HiringRecommendation;
  scores: Record<string, number>;
  grade: VerbalGrade | null;
}

/** A submission: only what the evaluator saw (the saved draft's revision and the criteria's fingerprint). */
export interface SubmitEvaluationRequest {
  revision: number;
  criteriaVersion: string;
}
