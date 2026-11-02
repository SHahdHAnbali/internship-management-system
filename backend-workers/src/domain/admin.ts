import { DomainError } from './errors';
import { optional, required } from './guard';
import { STAFF_ROLES, type UserRole } from './roles';

// Admin module rules (PDF §4, §8). Mirrors Ims.Domain: Fields/Field, Evaluations/EvaluationCriterion,
// Staff/Employee and Notifications/NotificationSettings, with the same codes and messages.

export const FIELD_NAME_MAX_LENGTH = 100;
export const FIELD_DESCRIPTION_MAX_LENGTH = 1000;
export const CRITERION_NAME_MAX_LENGTH = 200;
export const EMPLOYEE_NAME_MAX_LENGTH = 200;

/** A training field: name, description, active or not. Fields are deactivated, never deleted. */
export interface FieldValues {
  name: string;
  description: string | null;
  isActive: boolean;
}

export function fieldValues(name: string | null, description: string | null, isActive: boolean): FieldValues {
  return {
    name: required(name, 'Name', FIELD_NAME_MAX_LENGTH),
    description: optional(description, 'Description', FIELD_DESCRIPTION_MAX_LENGTH),
    isActive,
  };
}

/** A fixed evaluation criterion: name, weight (> 0) and display order. */
export interface CriterionValues {
  name: string;
  weight: number;
  sortOrder: number;
}

export function criterionValues(name: string | null, weight: number, sortOrder: number): CriterionValues {
  if (weight <= 0) {
    throw new DomainError('validation.range', 'Weight must be greater than zero.');
  }

  return { name: required(name, 'Name', CRITERION_NAME_MAX_LENGTH), weight, sortOrder };
}

/** First Google sign-in creates the staff account with the Employee role; higher roles come only from an Admin. */
export function newEmployeeName(fullName: string): string {
  return required(fullName, 'Full name', EMPLOYEE_NAME_MAX_LENGTH);
}

/** A staff member's role must be Employee, HR or Admin (never Trainee). */
export function staffRole(role: UserRole): UserRole {
  if (!STAFF_ROLES.includes(role)) {
    throw new DomainError('employee.invalid_role', "A staff member's role must be Employee, HR or Admin.");
  }

  return role;
}

/** PDF §7: the 7 / 3 / 5-day notification intervals, each at least one day. */
export interface NotificationIntervals {
  trainingEndingNoticeDays: number;
  lateEvaluationReminderDays: number;
  pendingRequestAlertDays: number;
}

export function notificationIntervals(values: NotificationIntervals): NotificationIntervals {
  return {
    trainingEndingNoticeDays: positiveDays(values.trainingEndingNoticeDays, 'Training ending notice'),
    lateEvaluationReminderDays: positiveDays(values.lateEvaluationReminderDays, 'Late evaluation reminder'),
    pendingRequestAlertDays: positiveDays(values.pendingRequestAlertDays, 'Pending request alert'),
  };
}

function positiveDays(days: number, name: string): number {
  if (days < 1) {
    throw new DomainError('validation.range', `${name} must be at least 1 day.`);
  }

  return days;
}
