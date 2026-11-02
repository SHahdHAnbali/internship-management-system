import { describe, expect, it } from 'vitest';
import corpus from './fixtures/email-corpus.json';
import { normalizeEmail } from '../src/domain/emailAddress';
import { DomainError } from '../src/domain/errors';

/**
 * E-mail validation must accept and normalise exactly what the C# API does (System.Net.Mail.MailAddress), or a trainee
 * or staff address valid in one API would be rejected by the other. The fixture holds the real .NET results.
 */
describe('normalizeEmail matches .NET EmailAddress.Normalize', () => {
  const cases = (corpus as unknown as { cases: [string | null, string][] }).cases;

  it(`agrees on all ${cases.length} corpus cases`, () => {
    const mismatches: string[] = [];
    for (const [input, expected] of cases) {
      let actual: string;
      try {
        actual = normalizeEmail(input);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        actual = `!${error.code}`;
      }

      if (actual !== expected)
        mismatches.push(
          `${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
    }

    expect(mismatches.slice(0, 20)).toEqual([]);
  });
});
