import { describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors';
import {
  CRITERIA_VERSION_PATTERN,
  criteriaVersion,
  draftInput,
  EVALUATION_COMMENT_MAX_LENGTH,
  isComplete,
  missingForSubmission,
  submitInput,
  verbalGrade,
} from '../src/domain/evaluation';

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

/**
 * Stage S2.3 (AD-71): the submission request, the criteria fingerprint, the exact verbal grade (AD-66, AD-68 G3/G8) and
 * what a draft still lacks. The mean never exists as a value: the grade compares whole numbers.
 */
describe('submission input', () => {
  const version = `c1.${'A'.repeat(43)}`;
  const both = ['revision', 'criteriaversion'];
  const refusedSubmit = (value: Record<string, unknown>, present = both) => {
    try {
      submitInput(value as never, present);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return (error as DomainError).code;
    }
    throw new Error(`Expected a refusal for ${JSON.stringify(value)}`);
  };

  it('accepts a revision and a criteria version, nothing else is read', () => {
    expect(submitInput({ revision: 2, criteriaVersion: version }, both)).toEqual({
      revision: 2,
      criteriaVersion: version,
    });
    expect(submitInput({ revision: 0, criteriaVersion: version }, both).revision).toBe(0);
  });

  it('requires both fields', () => {
    expect(refusedSubmit({ revision: 1, criteriaVersion: version }, ['criteriaversion'])).toBe('validation.required');
    expect(refusedSubmit({ revision: 1, criteriaVersion: version }, ['revision'])).toBe('validation.required');
  });

  it('refuses a negative revision and any criteria version not in the c1 format', () => {
    expect(refusedSubmit({ revision: -1, criteriaVersion: version })).toBe('validation.range');
    for (const value of [
      null,
      '',
      'c1.',
      `c2.${'A'.repeat(43)}`,
      `c1.${'A'.repeat(42)}`,
      `c1.${'A'.repeat(44)}`,
      `c1.${'A'.repeat(42)}=`,
      `c1.${'+'.repeat(43)}`,
    ]) {
      expect(refusedSubmit({ revision: 1, criteriaVersion: value }), String(value)).toBe('validation.invalid');
    }
  });
});

describe('criteria version (fingerprint of the active criteria)', () => {
  const a = { id: '01a1cccc-0000-7000-8000-000000000001', nameAr: 'التزام', nameEn: 'Punctuality', sortOrder: 1 };
  const b = { id: '01a1cccc-0000-7000-8000-000000000002', nameAr: 'حضور', nameEn: 'Attendance', sortOrder: 3 };

  it('is deterministic, in the c1 format, and follows the order, not the input order or the id case', async () => {
    const v = await criteriaVersion([a, b]);
    expect(v).toMatch(CRITERIA_VERSION_PATTERN);
    expect(await criteriaVersion([a, b])).toBe(v);
    expect(await criteriaVersion([b, a])).toBe(v);
    expect(await criteriaVersion([{ ...a, id: a.id.toUpperCase() }, b])).toBe(v);
    expect(await criteriaVersion([])).toMatch(CRITERIA_VERSION_PATTERN);
  });

  it('changes with any insertion, removal, rename in either language, id or order', async () => {
    const v = await criteriaVersion([a, b]);
    const changed = [
      [a],
      [b],
      [],
      [a, b, { ...b, id: '01a1cccc-0000-7000-8000-000000000003', sortOrder: 4 }],
      [{ ...a, nameAr: 'التزام بالمواعيد' }, b],
      [{ ...a, nameEn: 'Punctuality!' }, b],
      [{ ...a, id: '01a1cccc-0000-7000-8000-000000000009' }, b],
      [{ ...a, sortOrder: 2 }, b],
    ];
    const versions = await Promise.all(changed.map((c) => criteriaVersion(c)));
    for (const other of versions) expect(other).not.toBe(v);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('verbal grade (exact, unrounded, no mean value)', () => {
  const grade = (...scores: number[]) =>
    verbalGrade(
      scores.reduce((s, x) => s + x, 0),
      scores.length,
    );

  it('uses the AD-66 thresholds exactly at and around each boundary', () => {
    expect(grade(5, 4)).toBe('Excellent'); // 4.5
    expect(grade(5, 5, 4, 4)).toBe('Excellent'); // 4.5
    expect(grade(4, 5, 5)).toBe('Excellent'); // 4.67
    expect(grade(4, 4, 5)).toBe('VeryGood'); // 4.33
    expect(grade(4, 4, 4, 5)).toBe('VeryGood'); // 4.25
    expect(grade(3, 5)).toBe('VeryGood'); // 4.0
    expect(grade(3, 4)).toBe('Good'); // 3.5
    expect(grade(2, 4)).toBe('Good'); // 3.0
    expect(grade(3, 3, 2)).toBe('Pass'); // 2.67
    expect(grade(2, 3)).toBe('Pass'); // 2.5
    expect(grade(1, 3)).toBe('Pass'); // 2.0
    expect(grade(1, 2, 2)).toBe('Poor'); // 1.67
    expect(grade(1, 2)).toBe('Poor'); // 1.5
    expect(grade(1)).toBe('Poor');
    expect(grade(5)).toBe('Excellent');
  });

  it('matches the thresholds for every combination of 1 to 4 scores (5 + 25 + 125 + 625 cases)', () => {
    // Reference: the mean as a float, exact here (divisions by 1, 2, 4 are exact; thirds never land on a threshold).
    const reference = (scores: number[]) => {
      const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
      return mean >= 4.5 ? 'Excellent' : mean >= 4 ? 'VeryGood' : mean >= 3 ? 'Good' : mean >= 2 ? 'Pass' : 'Poor';
    };
    let cases = 0;
    const walk = (scores: number[]) => {
      if (scores.length > 0) {
        expect(grade(...scores), scores.join(',')).toBe(reference(scores));
        cases += 1;
      }
      if (scores.length < 4) for (let s = 1; s <= 5; s++) walk([...scores, s]);
    };
    walk([]);
    expect(cases).toBe(780);
  });

  it('has no grade without a frozen score, and refuses impossible totals', () => {
    expect(verbalGrade(0, 0)).toBeNull();
    for (const [sum, count] of [
      [0, 1],
      [6, 1],
      [11, 2],
      [-1, 0],
      [1.5, 1],
      [3, -1],
    ]) {
      expect(() => verbalGrade(sum!, count!), `${sum}/${count}`).toThrow();
    }
  });
});

describe('what a draft lacks for submission', () => {
  const C1 = '01a1cccc-0000-7000-8000-000000000001';
  const C2 = '01a1cccc-0000-7000-8000-000000000002';
  const complete = {
    comment: 'Good work',
    hiringRecommendation: 'Yes',
    scores: new Map([
      [C1, 4],
      [C2, 1],
    ]),
  };

  it('nothing when every active criterion is scored and the comment and recommendation are there', () => {
    const missing = missingForSubmission(complete, [C1, C2.toUpperCase()]);
    expect(missing).toEqual({ comment: false, hiringRecommendation: false, criteria: [] });
    expect(isComplete(missing)).toBe(true);
  });

  it('names each missing part: comment (blank or too long), recommendation, unscored active criteria', () => {
    expect(missingForSubmission({ ...complete, comment: '  ' }, [C1]).comment).toBe(true);
    expect(missingForSubmission({ ...complete, comment: null }, [C1]).comment).toBe(true);
    expect(missingForSubmission({ ...complete, comment: 'x'.repeat(4001) }, [C1]).comment).toBe(true);
    expect(missingForSubmission({ ...complete, comment: '😀'.repeat(4000) }, [C1]).comment).toBe(false);
    expect(missingForSubmission({ ...complete, hiringRecommendation: null }, [C1]).hiringRecommendation).toBe(true);
    expect(missingForSubmission({ ...complete, hiringRecommendation: 'Perhaps' }, [C1]).hiringRecommendation).toBe(
      true,
    );
    const unscored = missingForSubmission({ ...complete, scores: new Map([[C1, 4]]) }, [C1, C2]);
    expect(unscored.criteria).toEqual([C2]);
    expect(isComplete(unscored)).toBe(false);
  });

  it('a score of an inactive criterion is not required; with no active criterion the comment and recommendation still are', () => {
    expect(isComplete(missingForSubmission({ ...complete, scores: new Map([[C2, 3]]) }, [C2]))).toBe(true);
    expect(isComplete(missingForSubmission({ ...complete, scores: new Map() }, []))).toBe(true);
    expect(
      missingForSubmission({ comment: 'Only a comment', hiringRecommendation: null, scores: new Map() }, []),
    ).toEqual({
      comment: false,
      hiringRecommendation: true,
      criteria: [],
    });
  });
});
