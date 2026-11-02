import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useAuth } from '../../auth/context';
import { adminCache } from './adminCache';

/**
 * Loads a page's data from the API on mount and exposes loading/failed state plus a reload function.
 * Data loaded earlier in this session (`resource`) is shown immediately and refreshed in the background, so
 * `loading` is true only while there is nothing to show yet. Errors are always reported, even during a refresh.
 */
export function useLoad<T>(
  resource: string,
  load: () => Promise<T>,
  onError: (error: unknown) => void,
) {
  const { user } = useAuth();
  const key = adminCache.key(user?.id, resource);
  const [data, setState] = useState<T | null>(() => adminCache.get<T>(key) ?? null);
  const [loading, setLoading] = useState(() => adminCache.get<T>(key) === undefined);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ load, onError, key });
  const shown = useRef(data);

  useEffect(() => {
    callbacks.current = { load, onError, key };
    shown.current = data;
  });

  /** Updates the data shown and the cached copy (e.g. after a change saved through the API). */
  const setData = useCallback((value: SetStateAction<T | null>) => {
    setState((current) => {
      const next =
        typeof value === 'function' ? (value as (c: T | null) => T | null)(current) : value;
      if (next !== null) adminCache.set(callbacks.current.key, next);
      return next;
    });
  }, []);

  // State changes happen only when the request settles.
  const fetchData = useCallback(
    () =>
      callbacks.current
        .load()
        .then(
          (result) => {
            setData(result);
            setFailed(false);
          },
          (error: unknown) => {
            // Keep showing data already on screen, but never hide the error.
            if (shown.current === null) setFailed(true);
            callbacks.current.onError(error);
          },
        )
        .finally(() => setLoading(false)),
    [setData],
  );

  /** Re-reads the data (after a change); what is on screen stays visible meanwhile. */
  const reload = useCallback(() => fetchData(), [fetchData]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, setData, loading, failed, reload };
}
