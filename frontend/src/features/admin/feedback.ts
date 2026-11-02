import { useMemo } from 'react';
import { useToast } from '../../components/toastContext';
import { ApiError } from '../../lib/api';
import { previewActive } from '../../preview/mode';

/** Maps an API error to the translated Admin message. */
export function adminErrorKey(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  switch (status) {
    case 400:
      return 'admin.errors.invalid';
    case 401:
      return 'admin.errors.unauthorized';
    case 403:
      return 'admin.errors.forbidden';
    case 404:
      return 'admin.errors.notFound';
    case 409:
      return 'admin.errors.conflict';
    default:
      return 'admin.errors.generic';
  }
}

/** Success / error messages for Admin actions. In Preview Mode nothing reaches the server, so "saved" says so. */
export function useAdminFeedback() {
  const toast = useToast();
  return useMemo(
    () => ({
      saved: () => toast(previewActive ? 'preview.saved' : 'admin.messages.saved'),
      error: (error: unknown) => toast(adminErrorKey(error)),
    }),
    [toast],
  );
}
