import type { UserRole } from '../../auth/models';

export type { UserRole };

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

/** Staff hold Employee, HR or Admin (PDF §8). */
export const STAFF_ROLES: readonly UserRole[] = ['Employee', 'HR', 'Admin'];

export interface User {
  id: string;
  fullName: string;
  email: string;
  department: string | null;
  role: UserRole;
}

/** An accepted application (PDF §2: the Admin sees the accepted trainees), with its recorded assignments. */
export interface AcceptedTrainee {
  applicationId: string;
  trainee: {
    fullName: string | null;
    university: string | null;
    major: string | null;
    studyYear: string | null;
  };
  fieldName: string;
  availableFrom: string;
  availableTo: string;
  hours: number;
  mandatoryForUniversity: boolean;
  acceptedAt: string | null;
  assignments: {
    employeeName: string;
    status: 'Active' | 'Completed' | 'EndedEarly' | 'Transferred' | 'Withdrawn';
    startDate: string;
    endDate: string;
  }[];
}

/** PDF §7: the 7 / 3 / 5-day intervals the Admin can change. */
export interface NotificationSettings {
  trainingEndingNoticeDays: number;
  lateEvaluationReminderDays: number;
  pendingRequestAlertDays: number;
}
