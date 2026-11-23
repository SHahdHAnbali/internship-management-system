import { DomainError } from './errors';
import { isNullOrWhiteSpace, trimDotnet } from './text';
import { parseGuid } from './uuid';

/**
 * The final evaluation's shared draft (R27 stage S2.2; AD-66, AD-69 and the owner decisions of 2026-11-22, AD-70):
 * - every field is sent (a missing field never means "clear");
 * - `revision`: the draft's change counter the editor last saw, 0 for a draft not started;
 * - `comment`: optional while drafting, trimmed, blank means none, at most 4,000 characters counted as PostgreSQL counts
 *   them (code points);
 * - `hiringRecommendation`: optional while drafting, Yes / Maybe / No;
 * - `scores`: by criterion id, each a whole number from 1 to 5; never null: a saved score can change, never be cleared.
 *   An empty map is an incomplete draft; a criterion left out keeps whatever it has (a score, or none yet).
 */
export const EVALUATION_COMMENT_MAX_LENGTH = 4000;
export const MIN_SCORE = 1;
export const MAX_SCORE = 5;
export const HIRING_RECOMMENDATIONS = ['Yes', 'Maybe', 'No'] as const;
export type HiringRecommendation = (typeof HIRING_RECOMMENDATIONS)[number];

export interface DraftInput {
  revision: number;
  comment: string | null;
  hiringRecommendation: HiringRecommendation | null;
  /** Criterion id (lower case) → score. */
  scores: Map<string, number>;
}

/** The fields as bound from JSON, and the (lower-case) names of the fields the request actually contained. */
export function draftInput(
  value: { revision: number; comment: string | null; hiringRecommendation: string | null; scores: unknown },
  present: readonly string[],
): DraftInput {
  for (const field of ['revision', 'comment', 'hiringRecommendation', 'scores']) {
    if (!present.includes(field.toLowerCase()) && !present.includes(field)) {
      throw new DomainError('validation.required', `The ${field} field is required.`);
    }
  }

  if (!Number.isInteger(value.revision) || value.revision < 0) {
    throw new DomainError('validation.range', 'The revision must be a whole number of 0 or more.');
  }

  const comment = isNullOrWhiteSpace(value.comment) ? null : trimDotnet(value.comment);
  if (comment !== null && [...comment].length > EVALUATION_COMMENT_MAX_LENGTH) {
    throw new DomainError(
      'validation.too_long',
      `The comment must be at most ${EVALUATION_COMMENT_MAX_LENGTH} characters.`,
    );
  }

  const recommendation = value.hiringRecommendation;
  if (recommendation !== null && !(HIRING_RECOMMENDATIONS as readonly string[]).includes(recommendation)) {
    throw new DomainError('validation.invalid', 'The hiring recommendation must be Yes, Maybe or No.');
  }

  if (typeof value.scores !== 'object' || value.scores === null || Array.isArray(value.scores)) {
    throw new DomainError('validation.required', 'The scores field is required.');
  }
  const scores = new Map<string, number>();
  for (const [key, score] of Object.entries(value.scores)) {
    const criterion = parseGuid(key);
    if (!criterion || scores.has(criterion)) {
      throw new DomainError('validation.invalid', 'Scores must be given once per criterion, by criterion id.');
    }
    if (typeof score !== 'number' || !Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) {
      throw new DomainError('validation.range', `Each score must be a whole number from ${MIN_SCORE} to ${MAX_SCORE}.`);
    }
    scores.set(criterion, score);
  }

  return {
    revision: value.revision,
    comment,
    hiringRecommendation: recommendation as HiringRecommendation | null,
    scores,
  };
}

/**
 * Stage S2.3, submission (R27; AD-66, AD-68 G3/G8, AD-71). The request carries only what the evaluator saw: the draft's
 * revision and the fingerprint of the active criteria (`criteriaVersion`). Scores, comment, recommendation, submitter and
 * grade are never taken from the request: they are read from the saved draft and the signed-in user, under lock.
 */
export const CRITERIA_VERSION_PATTERN = /^c1\.[A-Za-z0-9_-]{43}$/;

export interface SubmitInput {
  revision: number;
  criteriaVersion: string;
}

/** The fields as bound from JSON, and the (lower-case) names of the fields the request actually contained. */
export function submitInput(
  value: { revision: number; criteriaVersion: string | null },
  present: readonly string[],
): SubmitInput {
  for (const field of ['revision', 'criteriaVersion']) {
    if (!present.includes(field.toLowerCase()) && !present.includes(field)) {
      throw new DomainError('validation.required', `The ${field} field is required.`);
    }
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    throw new DomainError('validation.range', 'The revision must be a whole number of 0 or more.');
  }
  if (typeof value.criteriaVersion !== 'string' || !CRITERIA_VERSION_PATTERN.test(value.criteriaVersion)) {
    throw new DomainError('validation.invalid', 'The criteria version is not valid.');
  }
  return { revision: value.revision, criteriaVersion: value.criteriaVersion };
}

/** An active criterion as the evaluator sees it; all four values are frozen at submission. */
export interface CriterionIdentity {
  id: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
}

/**
 * The fingerprint of the active criteria (AD-71): `c1.` + base64url (unpadded) of SHA-256 of the canonical JSON
 * `[[id, nameAr, nameEn, sortOrder], …]` in the (unique, immutable) order. Any insertion, activation, deactivation or
 * rename in either language changes it. Computed by the server each time; never stored.
 */
export async function criteriaVersion(criteria: readonly CriterionIdentity[]): Promise<string> {
  const ordered = [...criteria].sort((a, b) => a.sortOrder - b.sortOrder);
  const canonical = JSON.stringify(ordered.map((c) => [c.id.toLowerCase(), c.nameAr, c.nameEn, c.sortOrder]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  let text = '';
  for (const b of digest) text += String.fromCharCode(b);
  return `c1.${btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export const VERBAL_GRADES = ['Excellent', 'VeryGood', 'Good', 'Pass', 'Poor'] as const;
export type VerbalGrade = (typeof VERBAL_GRADES)[number];

/**
 * The verbal grade of `count` frozen scores totalling `sum` (AD-66, AD-68 G3/G8): the equal-weight mean compared without
 * rounding, by exact whole-number arithmetic, so the mean itself never exists as a value. Excellent ≥ 4.5; Very Good ≥ 4.0;
 * Good ≥ 3.0; Pass ≥ 2.0; Poor otherwise (no Fail). No frozen score (a comment-only evaluation): no grade.
 */
export function verbalGrade(sum: number, count: number): VerbalGrade | null {
  if (
    !Number.isInteger(sum) ||
    !Number.isInteger(count) ||
    count < 0 ||
    sum < MIN_SCORE * count ||
    sum > MAX_SCORE * count
  ) {
    throw new Error('The frozen scores are out of range.');
  }
  if (count === 0) return null;
  if (2 * sum >= 9 * count) return 'Excellent';
  if (sum >= 4 * count) return 'VeryGood';
  if (sum >= 3 * count) return 'Good';
  if (sum >= 2 * count) return 'Pass';
  return 'Poor';
}

/** What a saved draft still lacks for submission (AD-66; AD-71 decision 9: comment and recommendation always required). */
export interface MissingForSubmission {
  comment: boolean;
  hiringRecommendation: boolean;
  /** Active criteria without a saved score, in the given order. */
  criteria: string[];
}

export function missingForSubmission(
  draft: { comment: string | null; hiringRecommendation: string | null; scores: ReadonlyMap<string, number> },
  activeCriterionIds: readonly string[],
): MissingForSubmission {
  const comment = draft.comment;
  const commentMissing = isNullOrWhiteSpace(comment) || [...comment!].length > EVALUATION_COMMENT_MAX_LENGTH;
  const recommendation = draft.hiringRecommendation;
  const recommendationMissing =
    recommendation === null || !(HIRING_RECOMMENDATIONS as readonly string[]).includes(recommendation);
  const criteria = activeCriterionIds.filter((id) => {
    const score = draft.scores.get(id.toLowerCase());
    return score === undefined || !Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE;
  });
  return { comment: commentMissing, hiringRecommendation: recommendationMissing, criteria };
}

export const isComplete = (missing: MissingForSubmission) =>
  !missing.comment && !missing.hiringRecommendation && missing.criteria.length === 0;

/**
 * Stage S2.4, correcting a submitted evaluation (R27; owner decisions of 2026-11-23, AD-72). Every field is sent:
 * - `revision`: the evaluation's change counter the corrector last saw;
 * - `comment`: required, trimmed, at most 4,000 code points;
 * - `hiringRecommendation`: required, Yes / Maybe / No;
 * - `scores`: by criterion id, a whole number from 1 to 5 for exactly the frozen criteria (`{}` when there are none):
 *   checked against the frozen set inside the transaction;
 * - `reason`: optional, trimmed (blank means none), at most 2,000 code points; a reason alone is not a change.
 */
export const CORRECTION_REASON_MAX_LENGTH = 2000;

export interface CorrectionInput {
  revision: number;
  comment: string;
  hiringRecommendation: HiringRecommendation;
  /** Criterion id (lower case) → score. */
  scores: Map<string, number>;
  reason: string | null;
}

/** The fields as bound from JSON, and the (lower-case) names of the fields the request actually contained. */
export function correctionInput(
  value: {
    revision: number;
    comment: string | null;
    hiringRecommendation: string | null;
    scores: unknown;
    reason: string | null;
  },
  present: readonly string[],
): CorrectionInput {
  const draft = draftInput(value, present);
  if (!present.includes('reason')) throw new DomainError('validation.required', 'The reason field is required.');
  if (draft.comment === null) throw new DomainError('validation.required', 'The comment is required.');
  if (draft.hiringRecommendation === null) {
    throw new DomainError('validation.required', 'The hiring recommendation is required.');
  }
  const reason = isNullOrWhiteSpace(value.reason) ? null : trimDotnet(value.reason);
  if (reason !== null && [...reason].length > CORRECTION_REASON_MAX_LENGTH) {
    throw new DomainError(
      'validation.too_long',
      `The reason must be at most ${CORRECTION_REASON_MAX_LENGTH} characters.`,
    );
  }
  return {
    revision: draft.revision,
    comment: draft.comment,
    hiringRecommendation: draft.hiringRecommendation,
    scores: draft.scores,
    reason,
  };
}

/** The current values of a submitted evaluation: its comment, recommendation and frozen scores (criterion id → score). */
export interface CorrectableValues {
  comment: string;
  hiringRecommendation: string;
  scores: ReadonlyMap<string, number>;
}

export interface CorrectionDiff {
  comment: boolean;
  hiringRecommendation: boolean;
  /** Frozen criteria (lower case) whose score changes, with the new score. */
  scores: Map<string, number>;
}

/**
 * What a correction changes (AD-72). The scores must name exactly the frozen criteria (else `validation.invalid`); the
 * reason is never part of the diff, so a request that only adds a reason changes nothing.
 */
export function correctionDiff(current: CorrectableValues, input: CorrectionInput): CorrectionDiff {
  const frozen = [...current.scores.keys()].map((k) => k.toLowerCase());
  if (input.scores.size !== frozen.length || frozen.some((id) => !input.scores.has(id))) {
    throw new DomainError(
      'validation.invalid',
      'Scores must be given for exactly the criteria of the submitted evaluation.',
    );
  }
  const scores = new Map<string, number>();
  for (const [id, score] of current.scores) {
    const next = input.scores.get(id.toLowerCase())!;
    if (next !== score) scores.set(id.toLowerCase(), next);
  }
  return {
    comment: input.comment !== current.comment,
    hiringRecommendation: input.hiringRecommendation !== current.hiringRecommendation,
    scores,
  };
}

export const hasChanges = (diff: CorrectionDiff) => diff.comment || diff.hiringRecommendation || diff.scores.size > 0;
