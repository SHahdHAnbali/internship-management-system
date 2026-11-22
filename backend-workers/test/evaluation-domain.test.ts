import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors';
import { draftInput, EVALUATION_COMMENT_MAX_LENGTH } from '../src/domain/evaluation';

/**
 * The shared draft's input rules (R27 S2.2; AD-66, AD-69, owner decisions of 2026-11-22, AD-70): every field present;
 * a revision of 0 or more; an optional comment (trimmed, blank = none) of at most 4,000 characters; an optional
 * recommendation Yes / Maybe / No; scores keyed by criterion id, each a whole number 1 to 5, never null (a saved score
 * is never cleared); an empty score map is a valid, incomplete draft.
 */
const C1 = '01a1cccc-0000-7000-8000-000000000001';
const C2 = '01a1cccc-0000-7000-8000-000000000002';
const valid = { revision: 0, comment: null, hiringRecommendation: null, scores: {} };
const all = ['revision', 'comment', 'hiringRecommendation', 'scores'];

const refused = (value: Record<string, unknown>, present = all) => {
  try {
    draftInput(value as never, present);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).code;
  }
  throw new Error(`Expected a refusal for ${JSON.stringify(value)}`);
};

describe('draft input', () => {
  it('accepts an empty, incomplete draft', () => {
    expect(draftInput(valid, all)).toEqual({
      revision: 0,
      comment: null,
      hiringRecommendation: null,
      scores: new Map(),
    });
  });

  it('accepts some scores, a comment and a recommendation; ids are compared in lower case', () => {
    const input = draftInput(
      {
        revision: 3,
        comment: '  Good progress  ',
        hiringRecommendation: 'Maybe',
        scores: { [C1]: 1, [C2.toUpperCase()]: 5 },
      },
      all,
    );
    expect(input).toEqual({
      revision: 3,
      comment: 'Good progress',
      hiringRecommendation: 'Maybe',
      scores: new Map([
        [C1, 1],
        [C2, 5],
      ]),
    });
  });

  it('turns a blank comment into none', () => {
    expect(draftInput({ ...valid, comment: ' \n\t ' }, all).comment).toBeNull();
  });

  it('requires every field, even when its value may be null (a missing field never means "clear")', () => {
    for (const missing of all) {
      expect(
        refused(
          valid,
          all.filter((k) => k !== missing),
        ),
        missing,
      ).toBe('validation.required');
    }
    expect(refused({ ...valid, scores: null })).toBe('validation.required');
  });

  it('refuses a negative revision', () => {
    expect(refused({ ...valid, revision: -1 })).toBe('validation.range');
  });

  it('counts the comment in characters (code points), up to 4,000', () => {
    expect(EVALUATION_COMMENT_MAX_LENGTH).toBe(4000);
    expect(draftInput({ ...valid, comment: 'ع'.repeat(4000) }, all).comment).toHaveLength(4000);
    // 4,000 emoji are 8,000 UTF-16 units but 4,000 characters, as PostgreSQL counts them.
    expect([...draftInput({ ...valid, comment: '😀'.repeat(4000) }, all).comment!]).toHaveLength(4000);
    expect(refused({ ...valid, comment: 'ع'.repeat(4001) })).toBe('validation.too_long');
  });

  it('accepts only Yes, Maybe or No as the recommendation (or none)', () => {
    for (const value of ['Yes', 'Maybe', 'No']) {
      expect(draftInput({ ...valid, hiringRecommendation: value }, all).hiringRecommendation).toBe(value);
    }
    for (const value of ['yes', 'Perhaps', '', 'NO ']) {
      expect(refused({ ...valid, hiringRecommendation: value }), value).toBe('validation.invalid');
    }
  });

  it('accepts only whole numbers 1 to 5 as scores; null never clears a score', () => {
    for (const score of [0, 6, -1, 2.5, '3', true, null, {}, [], Number.NaN]) {
      expect(refused({ ...valid, scores: { [C1]: score } }), JSON.stringify(score)).toBe('validation.range');
    }
  });

  it('refuses a score keyed by anything but a criterion id, and the same criterion twice', () => {
    expect(refused({ ...valid, scores: { punctuality: 3 } })).toBe('validation.invalid');
    expect(refused({ ...valid, scores: { [C1]: 3, [C1.toUpperCase()]: 4 } })).toBe('validation.invalid');
  });
});
