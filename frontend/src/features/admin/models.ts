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

/** The tables the audit log records (every table with the audit trigger). */
export const AUDITED_TABLES = [
  'application_attachments',
  'assignments',
  'certificate_templates',
  'contact_logs',
  'employees',
  'evaluation_criteria',
  'fields',
  'mentor_requests',
  'notification_settings',
  'notifications',
  'progress_notes',
  'roles',
  'trainee_sign_in_codes',
  'trainees',
  'training_applications',
  'user_sessions',
] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

export const AUDIT_OPERATIONS = ['INSERT', 'UPDATE'] as const;
export const AUDIT_ACTOR_TYPES = ['Staff', 'Trainee', 'Anonymous', 'System', 'Database'] as const;

/**
 * One audit log entry as the viewer receives it (AD-51): safe metadata only, never the stored values, plus who acted by
 * name. `entityId` is null for the sign-in tables (session and sign-in code ids are not shown).
 */
export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorType: (typeof AUDIT_ACTOR_TYPES)[number];
  actorId: string | null;
  /** Staff and Trainee actors: whether the account was found. */
  actorKnown: boolean;
  /** The account's name (null when unknown, or a trainee who has not entered one). */
  actorName: string | null;
  /** Staff actors: their role now (roles are not kept historically). */
  actorCurrentRole: 'Admin' | 'HR' | 'Employee' | null;
  operation: (typeof AUDIT_OPERATIONS)[number];
  table: AuditedTable;
  entityId: string | null;
}

export interface AuditPage {
  hasMore: boolean;
  entries: AuditEntry[];
}

/** Viewer filters; '' = any. `from` / `to` are instants (ISO 8601), the end excluded. */
export interface AuditFilters {
  operation: string;
  table: string;
  actorType: string;
  actorId: string;
  from: string;
  to: string;
}
