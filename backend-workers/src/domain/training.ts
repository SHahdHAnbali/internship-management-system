import { DomainError } from './errors';
import { required } from './guard';
import { isNullOrWhiteSpace } from './text';

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
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const ASSIGNMENT_END_REASON_MAX_LENGTH = 2000;

/** The official calendar of IMS (AD-62, AD-63): every lifecycle date is compared with the Asia/Hebron day. */
export const OFFICIAL_TIME_ZONE = 'Asia/Hebron';

/** The `YYYY-MM-DD` calendar date of `instant` in `timeZone` (daylight saving included). */
export function calendarDate(instant: Date, timeZone: string = OFFICIAL_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(instant)
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** How HR ends a training in Phase 1 (AD-63): a successful completion, or the trainee's withdrawal. */
export type AssignmentEndingKind = 'completion' | 'withdrawal';

export interface AssignmentEnding {
  status: Extract<AssignmentStatus, 'Completed' | 'EndedEarly' | 'Withdrawn'>;
  /** The actual end date; it replaces the planned end date (L3). */
  endDate: string;
  reason: string | null;
}

/**
 * AD-63 (owner decisions 2026-11-11): HR ends an Active assignment with an actual end date chosen by HR (NEW-32), never
 * before the start date and never after today's Asia/Hebron date. A successful completion is `Completed` when that date
 * is on or after the planned end date, `EndedEarly` before it (D2), the latter with a mandatory reason (L8); a
 * withdrawal is `Withdrawn` with a mandatory reason. A normal completion takes no reason. No final evaluation is
 * required first: it follows the ending (D1).
 */
export function endAssignment(
  kind: AssignmentEndingKind,
  input: { endDate: string | null | undefined; reason: string | null | undefined },
  assignment: { status: string; startDate: string; plannedEndDate: string },
  today: string,
): AssignmentEnding {
  if (assignment.status !== 'Active') {
    throw new DomainError('assignment.invalid_status', 'Only an active training can be ended.');
  }
  const endDate = parseDate(input.endDate);
  if (!endDate) throw new DomainError('validation.required', 'The actual end date is required.');
  if (endDate < assignment.startDate) {
    throw new DomainError('assignment.end_before_start', 'The actual end date cannot be before the training starts.');
  }
  if (endDate > today) {
    throw new DomainError('assignment.end_in_future', 'The actual end date cannot be in the future.');
  }

  if (kind === 'withdrawal') {
    const reason = required(input.reason, 'Withdrawal reason', ASSIGNMENT_END_REASON_MAX_LENGTH);
    return { status: 'Withdrawn', endDate, reason };
  }
  if (endDate >= assignment.plannedEndDate) {
    if (!isNullOrWhiteSpace(input.reason)) {
      throw new DomainError('assignment.reason_not_applicable', 'A normal completion does not take a reason.');
    }
    return { status: 'Completed', endDate, reason: null };
  }
  const reason = required(input.reason, 'Early completion reason', ASSIGNMENT_END_REASON_MAX_LENGTH);
  return { status: 'EndedEarly', endDate, reason };
}

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
