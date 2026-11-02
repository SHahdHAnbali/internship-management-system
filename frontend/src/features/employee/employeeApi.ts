import { apiRequest } from '../../lib/api';
import type {
  AvailableFilters,
  AvailableTrainee,
  FieldOption,
  MyMentorRequest,
  MyTrainee,
  ProgressNote,
} from './models';

/** Employee API (`/api/employee/...`, Employee role only; only the signed-in employee's own requests and trainees). */
export const employeeApi = {
  fields: () => apiRequest<FieldOption[]>('GET', '/employee/fields'),
  available: (filters: AvailableFilters) => {
    const query = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value !== ''),
    ).toString();
    return apiRequest<AvailableTrainee[]>(
      'GET',
      `/employee/available-trainees${query ? `?${query}` : ''}`,
    );
  },
  cvLink: (applicationId: string) =>
    apiRequest<{ url: string }>('POST', `/employee/applications/${applicationId}/cv-link`),
  requestToTrain: (applicationId: string, note: string) =>
    apiRequest<{ id: string }>('POST', '/employee/mentor-requests', { applicationId, note }),
  myRequests: () => apiRequest<MyMentorRequest[]>('GET', '/employee/mentor-requests'),
  myTrainees: () => apiRequest<MyTrainee[]>('GET', '/employee/trainees'),
  notes: (assignmentId: string) =>
    apiRequest<ProgressNote[]>('GET', `/employee/assignments/${assignmentId}/notes`),
  addNote: (assignmentId: string, text: string) =>
    apiRequest<ProgressNote>('POST', `/employee/assignments/${assignmentId}/notes`, { text }),
};
