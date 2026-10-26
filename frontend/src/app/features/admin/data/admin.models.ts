/** Mirrors the API contracts in Ims.Application/Admin. */

export interface Field {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface CreateFieldRequest {
  name: string;
  description: string | null;
}

export interface UpdateFieldRequest extends CreateFieldRequest {
  isActive: boolean;
}

export interface EvaluationCriterion {
  id: string;
  name: string;
  weight: number;
  sortOrder: number;
}

export type SaveEvaluationCriterionRequest = Omit<EvaluationCriterion, 'id'>;

/** The four roles in the database (PDF §2). Staff hold Employee, HR or Admin. */
export type UserRole = 'Admin' | 'HR' | 'Trainee' | 'Employee';

export const STAFF_ROLES: readonly UserRole[] = ['Employee', 'HR', 'Admin'];

export interface User {
  id: string;
  fullName: string;
  email: string;
  department: string | null;
  role: UserRole;
}

/** PDF §7: the 7 / 3 / 5-day intervals the Admin can change. */
export interface NotificationSettings {
  trainingEndingNoticeDays: number;
  lateEvaluationReminderDays: number;
  pendingRequestAlertDays: number;
}
