import { apiRequest } from '../../lib/api';
import type {
  ApplicationStatus,
  ContactLogEntry,
  ContactMethod,
  HrApplication,
  HrAssignment,
  HrMentor,
  HrMentorRequest,
  HrTrainee,
  TraineeHistory,
  TraineeHistoryFilters,
} from './models';

/** HR API (`/api/hr/...`, HR role only). */
export const hrApi = {
  applications: (status: ApplicationStatus | '') =>
    apiRequest<HrApplication[]>('GET', `/hr/applications${status ? `?status=${status}` : ''}`),
  application: (id: string) => apiRequest<HrApplication>('GET', `/hr/applications/${id}`),
  review: (id: string) => apiRequest<HrApplication>('POST', `/hr/applications/${id}/review`),
  accept: (id: string) => apiRequest<HrApplication>('POST', `/hr/applications/${id}/accept`),
  reject: (id: string, reason: string) =>
    apiRequest<HrApplication>('POST', `/hr/applications/${id}/reject`, { reason }),
  contactLogs: (id: string) =>
    apiRequest<ContactLogEntry[]>('GET', `/hr/applications/${id}/contact-logs`),
  addContactLog: (
    id: string,
    entry: { contactDate: string; method: ContactMethod; summary: string },
  ) => apiRequest<ContactLogEntry>('POST', `/hr/applications/${id}/contact-logs`, entry),
  fileLink: (attachmentId: string) =>
    apiRequest<{ url: string }>('POST', `/hr/attachments/${attachmentId}/link`),
  mentorRequests: (status: HrMentorRequest['status'] | '') =>
    apiRequest<HrMentorRequest[]>('GET', `/hr/mentor-requests${status ? `?status=${status}` : ''}`),
  approve: (id: string, startDate: string, endDate: string) =>
    apiRequest<HrMentorRequest>('POST', `/hr/mentor-requests/${id}/approve`, {
      startDate,
      endDate,
    }),
  assignments: () => apiRequest<HrAssignment[]>('GET', '/hr/assignments'),
  /** AD-63: a successful completion; the server records Completed or EndedEarly from the date. */
  completeAssignment: (id: string, endDate: string, reason: string | null) =>
    apiRequest<HrAssignment>('POST', `/hr/assignments/${id}/complete`, { endDate, reason }),
  /** AD-63 L2, NEW-35: a later planned end date with a reason. */
  extendAssignment: (id: string, endDate: string, reason: string) =>
    apiRequest<HrAssignment>('POST', `/hr/assignments/${id}/extend`, { endDate, reason }),
  withdrawAssignment: (id: string, endDate: string, reason: string) =>
    apiRequest<HrAssignment>('POST', `/hr/assignments/${id}/withdraw`, { endDate, reason }),
  /**
   * AD-65: the current responsible HR transfers the training to another mentor with a reason: today (executed at once;
   * returns the new assignment) or a later date (scheduled; returns this assignment with its pending decision).
   */
  transferAssignment: (id: string, employeeId: string, transferDate: string, reason: string) =>
    apiRequest<HrAssignment>('POST', `/hr/assignments/${id}/transfer`, {
      employeeId,
      transferDate,
      reason,
    }),
  /** AD-65: the current responsible HR cancels a pending transfer, with a reason; returns the assignment. */
  cancelTransfer: (decisionId: string, reason: string) =>
    apiRequest<HrAssignment>('POST', `/hr/transfer-decisions/${decisionId}/cancel`, { reason }),
  /** AD-65: the users who hold the Employee role now (possible incoming mentors). */
  mentors: () => apiRequest<HrMentor[]>('GET', '/hr/mentors'),
  trainees: () => apiRequest<HrTrainee[]>('GET', '/hr/trainees'),
  /** One trainee's history; the optional filters narrow its trainings only (period overlap, field). */
  traineeHistory: (
    id: string,
    filters: TraineeHistoryFilters = { from: '', to: '', fieldId: '' },
  ) => {
    const query = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value) as [string, string][],
    ).toString();
    return apiRequest<TraineeHistory>(
      'GET',
      `/hr/trainees/${id}/history${query ? `?${query}` : ''}`,
    );
  },
  rejectRequest: (id: string) =>
    apiRequest<HrMentorRequest>('POST', `/hr/mentor-requests/${id}/reject`),
};
