/**
 * The Admin data each page loaded last, kept in memory (this browser tab only, never persisted) per signed-in user,
 * so returning to a page shows its data immediately while it is refreshed from the API. Pages always refresh on open
 * and after every change, so the API stays the source of truth; signing out clears everything.
 */
const entries = new Map<string, unknown>();

export const adminCache = {
  key: (userId: string | undefined, resource: string) => `${userId ?? 'anonymous'}:${resource}`,
  get: <T>(key: string): T | undefined => entries.get(key) as T | undefined,
  set: (key: string, value: unknown) => void entries.set(key, value),
  clear: () => entries.clear(),
};
