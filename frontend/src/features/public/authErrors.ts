import { ApiError } from '../../lib/api';

/** Maps a sign-in API error to its translated message. */
export function signInErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'auth.errors.generic';
  switch (true) {
    case error.code === 'auth.domain_not_allowed':
      return 'auth.errors.domainNotAllowed';
    case error.code === 'auth.invalid_code':
      return 'auth.errors.invalidCode';
    case error.status === 429:
      return 'auth.errors.tooManyRequests';
    case error.status === 503 || error.status === 0:
      return 'auth.errors.unavailable';
    case error.status === 400:
      return 'auth.errors.invalidEmail';
    case error.status === 401:
      return 'auth.errors.googleFailed';
    default:
      return 'auth.errors.generic';
  }
}
