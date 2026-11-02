import { apiRequest } from '../lib/api';

/** PDF §7 in-app events whose workflow exists (HR: new application, mentor request; Employee: HR's decision). */
export type NotificationType =
  | 'ApplicationSubmitted'
  | 'MentorRequestSubmitted'
  | 'MentorRequestApproved'
  | 'MentorRequestRejected';

export interface AppNotification {
  id: string;
  type: NotificationType;
  isRead: boolean;
  createdAt: string;
  applicationId: string | null;
  traineeName: string | null;
  fieldName: string | null;
  employeeName: string | null;
}

export interface Inbox {
  unreadCount: number;
  /** Older notifications exist after the last one of this page. */
  hasMore: boolean;
  notifications: AppNotification[];
}

/** The signed-in staff member's own notifications (`/api/notifications`, HR and Employee), newest first in pages. */
export const notificationsApi = {
  /** The newest page, or the page after notification `before` (the last one already shown). */
  inbox: (before?: string) =>
    apiRequest<Inbox>('GET', `/notifications${before ? `?before=${before}` : ''}`),
  markRead: (id: string) => apiRequest<void>('POST', `/notifications/${id}/read`),
};

/** Where each notification leads: the record it is about, in the recipient's own area. */
export function notificationLink(n: AppNotification): string {
  switch (n.type) {
    case 'ApplicationSubmitted':
      return n.applicationId ? `/hr/applications/${n.applicationId}` : '/hr/applications';
    case 'MentorRequestSubmitted':
      return '/hr/mentor-requests';
    default:
      return '/employee/trainees';
  }
}
