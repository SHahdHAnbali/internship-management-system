import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useI18n } from '../i18n/context';
import { previewActive } from '../preview/mode';
import { homeFor, SIGNING_OUT, type UserRole } from './models';
import { useAuth } from './context';

/**
 * Protects a role's area (PDF §2). Signed out → sign-in page (with return URL); signed in with another role → that
 * user's own area. `role={null}` is the account page of ordinary Google users, who have no role and no area.
 * This is navigation only: the API enforces the same rules on every request.
 */
export function RequireRole({ role, children }: { role: UserRole | null; children?: ReactNode }) {
  const { user, unavailable } = useAuth();
  const location = useLocation();

  // Admin Preview Mode (local development only) shows the Admin pages with mock data and no sign-in.
  if (role === 'Admin' && previewActive) {
    return children ?? <Outlet />;
  }

  // Unknown session: wait. If the API cannot be reached, say so rather than sending a signed-in user to sign in.
  if (user === undefined) {
    return unavailable ? <SessionUnavailable /> : null;
  }

  if (user === null) {
    const returnUrl = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/sign-in?returnUrl=${returnUrl}`} replace />;
  }

  return user.role === role ? (children ?? <Outlet />) : <Navigate to={homeFor(user)} replace />;
}

/**
 * The public homepage and the sign-in pages are for signed-out visitors; a signed-in user goes to their own area
 * (replacing the history entry, so Back does not return to the redirect). Nothing renders while the session loads;
 * if the API cannot be reached the public page is shown, and a signed-in user is redirected once the check succeeds.
 */
export function RequireSignedOut({ children }: { children?: ReactNode }) {
  const { user, unavailable } = useAuth();
  const signingOut = (useLocation().state as typeof SIGNING_OUT | null)?.signingOut === true;
  if (user === undefined && !unavailable) return null;
  return user && !signingOut ? <Navigate to={homeFor(user)} replace /> : (children ?? <Outlet />);
}

/** The session could not be checked (network or server error): retried automatically, or now with the button. */
function SessionUnavailable() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  return (
    <main className="mx-auto max-w-content px-gutter py-12">
      <div className="ims-state" role="status">
        <p>{t('auth.sessionUnavailable')}</p>
        <button type="button" className="ims-btn-outline mt-4" onClick={() => void refresh()}>
          {t('auth.retry')}
        </button>
      </div>
    </main>
  );
}
