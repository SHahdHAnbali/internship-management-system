import { DomainError } from './errors';

/**
 * A one-time sign-in link and code e-mailed to a trainee (PDF §2, §9: link or code, valid for 15 minutes). Only hashes
 * are stored. Usable once, until it expires, is replaced by a newer request, or has had 5 wrong codes entered.
 * Mirrors Ims.Domain.Trainees.TraineeSignInCode.
 */
export const MAX_FAILED_ATTEMPTS = 5;

export interface TraineeSignInCode {
  id: string;
  email: string;
  tokenHash: string;
  codeHash: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  supersededAt: Date | null;
  failedAttempts: number;
  /** PostgreSQL `xmin`, the optimistic-concurrency token EF Core uses for this row. */
  version: string;
}

export function expiryFor(now: Date, lifetimeMinutes: number): Date {
  if (lifetimeMinutes <= 0) {
    throw new DomainError('validation.range', 'The sign-in code lifetime must be positive.');
  }

  return new Date(now.getTime() + lifetimeMinutes * 60_000);
}

export function isUsable(code: TraineeSignInCode, now: Date): boolean {
  return (
    code.usedAt === null &&
    code.supersededAt === null &&
    code.failedAttempts < MAX_FAILED_ATTEMPTS &&
    now.getTime() < code.expiresAt.getTime()
  );
}

export function assertUsable(code: TraineeSignInCode, now: Date): void {
  if (!isUsable(code, now)) {
    throw new DomainError('auth.code_unusable', 'The sign-in code is expired or already used.');
  }
}
