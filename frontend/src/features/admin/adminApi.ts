import { apiRequest } from '../../lib/api';
import type {
  CertificateImageKind,
  CertificateSettings,
  CertificateTemplate,
} from './certificate/model';
import type {
  AcceptedTrainee,
  AuditFilters,
  AuditPage,
  CreateEvaluationCriterionRequest,
  CreateFieldRequest,
  EvaluationCriterion,
  Field,
  NotificationSettings,
  UpdateEvaluationCriterionRequest,
  UpdateFieldRequest,
  User,
  UserRole,
} from './models';

const CERTIFICATE_TEMPLATE = '/admin/certificate-template';

/** Admin API (`/api/admin/...`, Admin role only). */
export const adminApi = {
  listFields: () => apiRequest<Field[]>('GET', '/admin/fields'),
  createField: (request: CreateFieldRequest) => apiRequest<Field>('POST', '/admin/fields', request),
  updateField: (id: string, request: UpdateFieldRequest) =>
    apiRequest<Field>('PUT', `/admin/fields/${id}`, request),
  listCriteria: () => apiRequest<EvaluationCriterion[]>('GET', '/admin/evaluation-criteria'),
  createCriterion: (request: CreateEvaluationCriterionRequest) =>
    apiRequest<EvaluationCriterion>('POST', '/admin/evaluation-criteria', request),
  updateCriterion: (id: string, request: UpdateEvaluationCriterionRequest) =>
    apiRequest<EvaluationCriterion>('PUT', `/admin/evaluation-criteria/${id}`, request),
  listUsers: () => apiRequest<User[]>('GET', '/admin/users'),
  changeUserRole: (id: string, role: UserRole) =>
    apiRequest<User>('PUT', `/admin/users/${id}/role`, { role }),
  listAcceptedTrainees: () => apiRequest<AcceptedTrainee[]>('GET', '/admin/accepted-trainees'),
  /** AD-64: appoint a replacement responsible HR (a user who holds the HR role now). */
  appointResponsibleHr: (applicationId: string, hrId: string) =>
    apiRequest<AcceptedTrainee>('PUT', `/admin/accepted-trainees/${applicationId}/responsible-hr`, {
      hrId,
    }),
  /** The audit log, newest first; `cursor` = the previous page's `nextCursor`, for the next (older) page. */
  auditLogs: (filters: AuditFilters, cursor?: string) => {
    const query = new URLSearchParams(
      Object.entries({ ...filters, cursor: cursor ?? '' }).filter(([, value]) => value),
    ).toString();
    return apiRequest<AuditPage>('GET', `/admin/audit-logs${query ? `?${query}` : ''}`);
  },
  getNotificationSettings: () =>
    apiRequest<NotificationSettings>('GET', '/admin/settings/notifications'),
  updateNotificationSettings: (settings: NotificationSettings) =>
    apiRequest<NotificationSettings>('PUT', '/admin/settings/notifications', settings),
  getCertificateTemplate: () => apiRequest<CertificateTemplate>('GET', CERTIFICATE_TEMPLATE),
  saveCertificateTemplate: (settings: CertificateSettings, version: string | null) =>
    apiRequest<CertificateTemplate>('PUT', CERTIFICATE_TEMPLATE, { settings, version }),
  uploadCertificateImage: (kind: CertificateImageKind, file: Blob) =>
    apiRequest<CertificateTemplate>('PUT', `${CERTIFICATE_TEMPLATE}/${kind}`, file),
  removeCertificateImage: (kind: CertificateImageKind) =>
    apiRequest<CertificateTemplate>('DELETE', `${CERTIFICATE_TEMPLATE}/${kind}`),
};
