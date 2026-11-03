import { apiRequest } from '../lib/api';

export interface MentorProfile {
  employee: { id: string; fullName: string };
  /** Distinct trainees across the employee's assignments, every stored status (PDF «عدد من درّبهم»). */
  trainees: number;
  /** Assignment records of the employee, every stored status. */
  assignments: number;
}

/** The mentor profile: every employee for HR (`/api/hr/...`), or the signed-in employee's own (`/api/employee/...`). */
export const mentorProfileApi = {
  all: () => apiRequest<{ rows: MentorProfile[] }>('GET', '/hr/reports/mentor-profile'),
  own: () => apiRequest<MentorProfile>('GET', '/employee/reports/mentor-profile'),
};
