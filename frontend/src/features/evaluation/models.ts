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

export interface EvaluationDetail extends EvaluationSummary {
  startDate: string;
  /** No criterion: the evaluation is a written comment only (AD-66). */
  commentOnly: boolean;
  /** The active criteria in their order; once submitted, the criteria frozen at submission. */
  criteria: EvaluationCriterion[];
}
