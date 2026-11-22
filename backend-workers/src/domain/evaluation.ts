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
