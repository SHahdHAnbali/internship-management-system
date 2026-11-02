import { apiRequest } from '../lib/api';
import type { AuthConfig, SessionUser } from './models';

/** Sign-in endpoints of the API (`/api/auth`). The session itself is an HttpOnly cookie set by the API. */
export const authApi = {
  me: () => apiRequest<SessionUser>('GET', '/auth/me'),
  config: () => apiRequest<AuthConfig>('GET', '/auth/config'),
  signInWithGoogle: (idToken: string) =>
    apiRequest<SessionUser>('POST', '/auth/staff/google', { idToken }),
  requestTraineeCode: (email: string) =>
    apiRequest<void>('POST', '/auth/trainee/request', { email }),
  verifyTraineeCode: (email: string, code: string) =>
    apiRequest<SessionUser>('POST', '/auth/trainee/verify', { email, code }),
  verifyTraineeLink: (token: string) =>
    apiRequest<SessionUser>('POST', '/auth/trainee/verify', { token }),
  signOut: () => apiRequest<void>('POST', '/auth/sign-out'),
};
