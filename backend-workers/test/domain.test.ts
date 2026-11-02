import { describe, expect, it } from 'vitest';
import { criterionValues, fieldValues, newEmployeeName, notificationIntervals, staffRole } from '../src/domain/admin';
import { normalizeEmail } from '../src/domain/emailAddress';
import { DomainError } from '../src/domain/errors';
import { isNullOrWhiteSpace, toLowerInvariant, trimDotnet } from '../src/domain/text';
import { expiryFor, isUsable, MAX_FAILED_ATTEMPTS, type TraineeSignInCode } from '../src/domain/traineeSignInCode';
import { parseGuid, uuidV7 } from '../src/domain/uuid';

/** Port of Ims.UnitTests (AdminDomainTests, TraineeSignInCodeTests, EntityTests) plus .NET string semantics. */
function domainError(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }

  throw new Error('Expected a DomainError.');
}

describe('Admin domain', () => {
  it('a new staff account gets the Employee role and a normalised e-mail', () => {
    expect(normalizeEmail('  New.Hire@Company.com ')).toBe('new.hire@company.com');
    expect(newEmployeeName('New Hire')).toBe('New Hire');
  });

  it.each(['HR', 'Admin', 'Employee'] as const)('an Admin can grant the staff role %s', (role) => {
    expect(staffRole(role)).toBe(role);
  });

  it('a staff member cannot be given the Trainee role', () => {
    expect(domainError(() => staffRole('Trainee')).code).toBe('employee.invalid_role');
  });

  it('fields start active and can be edited and deactivated', () => {
    expect(fieldValues(' Backend ', 'APIs', true)).toEqual({ name: 'Backend', description: 'APIs', isActive: true });
    expect(fieldValues('Backend & APIs', '  ', false)).toEqual({
      name: 'Backend & APIs',
      description: null,
      isActive: false,
    });
  });

  it('a field needs a name of at most 100 characters', () => {
    expect(domainError(() => fieldValues('  ', null, true))).toMatchObject({
      code: 'validation.required',
      message: 'Name is required.',
    });
    expect(domainError(() => fieldValues('x'.repeat(101), null, true))).toMatchObject({
      code: 'validation.too_long',
      message: 'Name must be at most 100 characters.',
    });
    expect(fieldValues(` ${'x'.repeat(100)} `, null, true).name).toHaveLength(100); // trimmed before the check
  });

  it.each([0, -1])('a criterion weight of %s is rejected', (weight) => {
    expect(domainError(() => criterionValues('Teamwork', weight, 1)).code).toBe('validation.range');
  });

  it('criteria keep name, weight and order', () => {
    expect(criterionValues('Communication', 1, 1)).toEqual({ name: 'Communication', weight: 1, sortOrder: 1 });
  });

  it('notification intervals must be at least one day', () => {
    expect(
      notificationIntervals({ trainingEndingNoticeDays: 7, lateEvaluationReminderDays: 3, pendingRequestAlertDays: 5 }),
    ).toEqual({
      trainingEndingNoticeDays: 7,
      lateEvaluationReminderDays: 3,
      pendingRequestAlertDays: 5,
    });
    expect(
      domainError(() =>
        notificationIntervals({
          trainingEndingNoticeDays: 0,
          lateEvaluationReminderDays: 3,
          pendingRequestAlertDays: 5,
        }),
      ).message,
    ).toBe('Training ending notice must be at least 1 day.');
    expect(
      domainError(() =>
        notificationIntervals({
          trainingEndingNoticeDays: 10,
          lateEvaluationReminderDays: 0,
          pendingRequestAlertDays: 5,
        }),
      ).message,
    ).toBe('Late evaluation reminder must be at least 1 day.');
  });
});

describe('Trainee sign-in code', () => {
  const now = new Date('2026-10-26T09:00:00Z');
  const issue = (changes: Partial<TraineeSignInCode> = {}): TraineeSignInCode => ({
    id: uuidV7(now),
    email: normalizeEmail(' Student@Uni.Example '),
    tokenHash: 'a'.repeat(64),
    codeHash: 'b'.repeat(64),
    issuedAt: now,
    expiresAt: expiryFor(now, 15),
    usedAt: null,
    supersededAt: null,
    failedAttempts: 0,
    version: '1',
    ...changes,
  });

  it('is usable until 15 minutes after issue', () => {
    const code = issue();
    expect(code.email).toBe('student@uni.example');
    expect(isUsable(code, new Date(now.getTime() + (14 * 60 + 59) * 1000))).toBe(true);
    expect(isUsable(code, new Date(now.getTime() + 15 * 60_000))).toBe(false);
  });

  it('can be used only once and is invalidated by a newer request', () => {
    expect(isUsable(issue({ usedAt: now }), now)).toBe(false);
    expect(isUsable(issue({ supersededAt: now }), now)).toBe(false);
  });

  it('is locked by five wrong attempts', () => {
    expect(isUsable(issue({ failedAttempts: MAX_FAILED_ATTEMPTS - 1 }), now)).toBe(true);
    expect(isUsable(issue({ failedAttempts: MAX_FAILED_ATTEMPTS }), now)).toBe(false);
  });

  it('needs a positive lifetime', () => {
    expect(domainError(() => expiryFor(now, 0)).code).toBe('validation.range');
  });

  it('trainee accounts use normalised e-mails', () => {
    expect(normalizeEmail(' A.B@Uni.Example ')).toBe('a.b@uni.example');
    expect(domainError(() => normalizeEmail('not-an-email')).code).toBe('validation.email');
  });
});

describe('Ids', () => {
  it('are time-ordered UUID version 7, distinct', () => {
    const now = new Date('2026-10-27T12:00:00.123Z');
    const id = uuidV7(now);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now.getTime());
    expect(uuidV7(now)).not.toBe(id);
  });

  it('are parsed like Guid.TryParse in route values (N, D, B, P formats)', () => {
    const d = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    expect(parseGuid(d.toUpperCase())).toBe(d);
    expect(parseGuid(d.replace(/-/g, ''))).toBe(d);
    expect(parseGuid(`{${d}}`)).toBe(d);
    expect(parseGuid(`(${d})`)).toBe(d);
    for (const bad of ['not-a-guid', d.slice(1), `${d}0`, d.replace('-', ''), `{${d}`, '']) {
      expect(parseGuid(bad)).toBeNull();
    }
  });
});

describe('.NET string semantics', () => {
  it('trims and tests white space like char.IsWhiteSpace', () => {
    expect(trimDotnet('\u0085 a  ')).toBe('a');
    expect(trimDotnet('﻿a')).toBe('﻿a'); // U+FEFF is not white space in .NET
    expect(isNullOrWhiteSpace(' \t ')).toBe(true);
    expect(isNullOrWhiteSpace('​')).toBe(false);
  });

  it('lower-cases like ToLowerInvariant (no special casing)', () => {
    expect(toLowerInvariant('ABC İ ΣΑΣ K')).toBe('abc İ σασ k');
  });
});
