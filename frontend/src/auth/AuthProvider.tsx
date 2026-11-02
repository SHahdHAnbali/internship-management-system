import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { authApi } from './authApi';
import { AuthContext, type Auth } from './context';
import type { SessionUser } from './models';

/** Waits between session checks while the API cannot be reached (the last one repeats). */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Mirrors who is signed in (from `GET /api/auth/me`). Nothing secret is stored in the browser: the session is an
 * HttpOnly cookie, and the API re-checks the account and its role on every request.
 * Only the API's answer 401/403 means "signed out". A network or server failure says nothing about the session, so
 * what is known is kept, `unavailable` is set and the check is repeated until the API answers.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  const loading = useRef<Promise<SessionUser | null> | null>(null);
  const retry = useRef<{ attempt: number; timer?: ReturnType<typeof setTimeout> }>({ attempt: 0 });

  const refresh = useCallback(async function check(): Promise<SessionUser | null> {
    clearTimeout(retry.current.timer);
    try {
      const me = await authApi.me();
      retry.current.attempt = 0;
      setUnavailable(false);
      setUser(me);
      return me;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        retry.current.attempt = 0;
        setUnavailable(false);
        setUser(null);
        return null;
      }

      loading.current = null;
      setUnavailable(true);
      const delay = RETRY_DELAYS_MS[Math.min(retry.current.attempt++, RETRY_DELAYS_MS.length - 1)];
      retry.current.timer = setTimeout(() => void check(), delay);
      return null;
    }
  }, []);

  useEffect(() => {
    loading.current ??= refresh();
  }, [refresh]);

  // Check again as soon as the device is back online, and stop retrying when the app goes away.
  useEffect(() => {
    if (!unavailable) return;
    const online = () => void refresh();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [unavailable, refresh]);
  useEffect(() => () => clearTimeout(retry.current.timer), []);

  const accept = useCallback((signedIn: SessionUser) => {
    clearTimeout(retry.current.timer);
    setUnavailable(false);
    setUser(signedIn);
    loading.current = Promise.resolve(signedIn);
    return signedIn;
  }, []);

  const value = useMemo<Auth>(
    () => ({
      user,
      unavailable,
      refresh,
      signInWithGoogle: async (idToken) => accept(await authApi.signInWithGoogle(idToken)),
      requestTraineeCode: (email) => authApi.requestTraineeCode(email),
      verifyTraineeCode: async (email, code) =>
        accept(await authApi.verifyTraineeCode(email, code)),
      verifyTraineeLink: async (token) => accept(await authApi.verifyTraineeLink(token)),
      signOut: async () => {
        clearTimeout(retry.current.timer);
        try {
          await authApi.signOut();
        } finally {
          setUnavailable(false);
          setUser(null);
          loading.current = Promise.resolve(null);
        }
      },
    }),
    [user, unavailable, refresh, accept],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
