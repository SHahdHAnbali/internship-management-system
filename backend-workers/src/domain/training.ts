import { DomainError } from './errors';
import { required } from './guard';

/**
 * Rules of the trainee lifecycle, mirroring Ims.Domain.Applications and Ims.Domain.Mentoring (same limits, codes and
 * messages). The database enforces the same constraints (EF Core migration TraineeApplicationsAndMentoring).
 */
export const PROFILE_LIMITS = { fullName: 200, phone: 50, university: 200, major: 200, studyYear: 50 } as const;
export const REJECTION_REASON_MAX_LENGTH = 2000;
export const MENTOR_NOTE_MAX_LENGTH = 2000;
export const PROGRESS_NOTE_MAX_LENGTH = 4000;
export const CONTACT_SUMMARY_MAX_LENGTH = 4000;
/** PDF §8: phone / meeting / e-mail. */
export const CONTACT_METHODS = ['Phone', 'Meeting', 'Email'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];
export const FILE_NAME_MAX_LENGTH = 255;
export const CONTENT_TYPE_MAX_LENGTH = 255;

/** Owner decision 2026-10-29: Submitted → UnderReview → Accepted / Rejected (final). */
export const APPLICATION_STATUSES = ['Submitted', 'UnderReview', 'Accepted', 'Rejected'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
/** PDF §8. */
export const MENTOR_REQUEST_STATUSES = ['Pending', 'Approved', 'Rejected'] as const;
export type MentorRequestStatus = (typeof MENTOR_REQUEST_STATUSES)[number];
/** Owner decision 2026-10-29. */
export const ASSIGNMENT_STATUSES = ['Active', 'Completed', 'EndedEarly', 'Transferred', 'Withdrawn'] as const;

export interface TraineeProfile {
  fullName: string;
  phone: string;
  university: string;
  major: string;
  studyYear: string;
}

export function traineeProfile(input: Record<keyof TraineeProfile, string | null>): TraineeProfile {
  return {
    fullName: required(input.fullName, 'Name', PROFILE_LIMITS.fullName),
    phone: required(input.phone, 'Phone', PROFILE_LIMITS.phone),
    university: required(input.university, 'University', PROFILE_LIMITS.university),
    major: required(input.major, 'Major', PROFILE_LIMITS.major),
    studyYear: required(input.studyYear, 'Study year', PROFILE_LIMITS.studyYear),
  };
}

/** A calendar date `YYYY-MM-DD` (as sent by `<input type="date">`), or null when absent or invalid. */
export function parseDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : null;
}

/** A period given as two dates; the end may not be before the start. */
export function period(from: string | null | undefined, to: string | null | undefined, name: string, code: string) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) throw new DomainError('validation.required', `${name} needs a valid start and end date.`);
  if (end < start) throw new DomainError(code, `${name} must end on or after its start.`);
  return { start, end };
}

export function applicationHours(value: string | null | undefined): number {
  const hours = Number(value);
  if (value == null || value.trim() === '' || !Number.isInteger(hours) || hours <= 0 || hours > 2_147_483_647) {
    throw new DomainError('validation.range', 'Hours must be a whole number greater than zero.');
  }

  return hours;
}

/** Owner decision 2026-10-29: HR puts a submitted application under review explicitly. */
export function assertCanReview(status: ApplicationStatus): void {
  if (status !== 'Submitted') {
    throw new DomainError('application.invalid_status', 'Only a submitted application can be put under review.');
  }
}

/** HR may accept or reject from Submitted or UnderReview; Accepted and Rejected are final. */
export function assertCanDecide(status: ApplicationStatus): void {
  if (status !== 'Submitted' && status !== 'UnderReview') {
    throw new DomainError('application.invalid_status', 'The application has already been decided.');
  }
}

export function assertPending(status: MentorRequestStatus): void {
  if (status !== 'Pending') {
    throw new DomainError('mentor_request.invalid_status', 'The request has already been decided.');
  }
}
