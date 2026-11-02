import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useAuth } from '../auth/context';
import { SIGNING_OUT } from '../auth/models';
import { useI18n } from '../i18n/context';
import { NotificationsMenu } from '../notifications/NotificationsMenu';
import { LanguageSwitch } from './LanguageSwitch';
import { Logo } from './Logo';

export interface AreaTab {
  /** Absolute path of the tab. */
  to: string;
  /** Translation key of its label. */
  label: string;
  /** Active only on exactly this path (for an area's index page). */
  end?: boolean;
}

/**
 * The frame of a role area (Trainee, Employee, HR, account): logo with the role, language switch and sign-out, and the
 * area's tabs when it has several pages.
 */
export function AreaShell({ tabs, children }: { tabs?: AreaTab[]; children: ReactNode }) {
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="border-b border-divider bg-surface">
        <div className="mx-auto flex min-h-header max-w-content items-center justify-between gap-2 px-gutter sm:gap-4">
          <Link to="/" className="flex flex-none items-center gap-2 py-2">
            <Logo className="h-9 w-auto sm:h-11" />
            {user?.role && (
              <span className="ims-badge hidden sm:inline-flex">{t(`roles.${user.role}`)}</span>
            )}
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            {/* PDF §7: only HR and employees receive in-app notifications. */}
            {(user?.role === 'HR' || user?.role === 'Employee') && <NotificationsMenu />}
            <LanguageSwitch />
            <button
              type="button"
              className="ims-btn-outline"
              onClick={async () => {
                // Leave the protected area first; otherwise its guard redirects to sign-in as the session ends.
                navigate('/', { replace: true, state: SIGNING_OUT });
                await signOut();
              }}
            >
              {t('auth.signOut')}
            </button>
          </div>
        </div>
        {tabs && tabs.length > 0 && (
          <nav aria-label={t('areas.navLabel')} className="border-t border-divider">
            <div className="mx-auto max-w-content px-gutter">
              <ul className="-mx-4 flex flex-wrap">
                {tabs.map((tab) => (
                  <li key={tab.to}>
                    <NavLink to={tab.to} end={tab.end} className="ims-tab">
                      {t(tab.label)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}
      </header>

      <main className="mx-auto w-full max-w-content flex-1 px-gutter py-6 sm:py-12">
        {children}
      </main>
    </div>
  );
}
