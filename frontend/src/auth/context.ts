import { createContext, useContext } from 'react';
import type { SessionUser } from './models';

export interface Auth {
  /** undefined while the session is loading, null when nobody is signed in. */
  user: SessionUser | null | undefined;
  /** The API could not be reached to check the session (network or server error); it is checked again shortly. */
  unavailable: boolean;
  /** Re-checks the session: the user, or null when signed out or when the API could not be reached. */
  refresh: () => Promise<SessionUser | null>;
  signInWithGoogle: (idToken: string) => Promise<SessionUser>;
  requestTraineeCode: (email: string) => Promise<void>;
  verifyTraineeCode: (email: string, code: string) => Promise<SessionUser>;
  verifyTraineeLink: (token: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>.');
  return auth;
}
