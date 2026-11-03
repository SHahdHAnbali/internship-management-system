import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../auth/context';
import { SIGNING_OUT } from '../../auth/models';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { useI18n } from '../../i18n/context';
import { adminCache } from './adminCache';
import { prefetchCertificateTemplate } from './certificate/prefetch';

export interface AdminNavLink {
  /** Path inside /admin. */
  path: string;
  /** Translation key of the label. */
  label: string;
}

const LINKS: AdminNavLink[] = [
  { path: 'fields', label: 'admin.nav.fields' },
  { path: 'evaluation-criteria', label: 'admin.nav.criteria' },
  { path: 'users', label: 'admin.nav.users' },
  { path: 'accepted-trainees', label: 'admin.nav.acceptedTrainees' },
  { path: 'reports', label: 'admin.nav.reports' },
  { path: 'settings', label: 'admin.nav.settings' },
  { path: 'certificate', label: 'admin.nav.certificate' },
];

/**
 * Shell of the Admin area (PDF §4): the title, AR/EN switch and account on the first row, the Admin pages on their
 * own row below (see AdminNav), so labels never compete with the header for space.
 */
export function AdminLayout() {
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const openedAt = useRef(useLocation().pathname);

  // Fetch the code of every Admin page once the area is open, so switching pages never waits for a download.
  useEffect(() => preloadAdminPages(), []);
  // And the saved certificate template, unless the area opened on the editor itself (which loads it anyway).
  useEffect(() => {
    if (!openedAt.current.startsWith('/admin/certificate')) prefetchCertificateTemplate(user?.id);
  }, [user?.id]);

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-divider bg-surface">
        <div className="mx-auto flex min-h-header max-w-content items-center gap-3 px-gutter">
          <NavLink
            to="/admin"
            className="flex min-w-0 flex-1 items-center gap-2 font-bold tracking-[-0.01em] text-heading hover:text-heading"
          >
            <span className="size-2.5 flex-none rounded-full bg-brand" aria-hidden="true" />
            <span className="min-w-0 truncate text-[1.0625rem]">{t('app.title')}</span>
            <span className="ims-badge flex-none">{t('admin.title')}</span>
          </NavLink>

          <div className="flex flex-none items-center gap-1">
            <LanguageSwitch />
            {user && (
              <>
                <span
                  className="hidden max-w-48 truncate text-small text-muted lg:inline"
                  title={user.email}
                >
                  {user.name ?? user.email}
                </span>
                <button
                  type="button"
                  className="ims-btn-outline"
                  onClick={async () => {
                    // Leave the protected area first; otherwise its guard redirects to sign-in as the session ends.
                    navigate('/', { replace: true, state: SIGNING_OUT });
                    adminCache.clear();
                    await signOut();
                  }}
                >
                  {t('auth.signOut')}
                </button>
              </>
            )}
          </div>
        </div>

        <AdminNav links={LINKS} />
      </header>

      <main className="mx-auto max-w-content px-gutter py-6 sm:py-12">
        <Outlet />
      </main>
    </>
  );
}

/**
 * The Admin pages. Wide screens (≥ the `nav` breakpoint): a row of tabs that wraps onto another line when there are more
 * pages than fit, so no label is ever clipped or scrolled out of reach. Narrower screens: one button showing the
 * current page, opening the full list.
 */
export function AdminNav({ links }: { links: readonly AdminNavLink[] }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const current = links.find((link) => pathname.startsWith(`/admin/${link.path}`));

  return (
    <nav
      aria-label={t('admin.nav.label')}
      className="border-t border-divider"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <div className="mx-auto max-w-content px-gutter">
        <ul className="-mx-4 hidden flex-wrap nav:flex">
          {links.map((link) => (
            <li key={link.path}>
              <NavLink to={link.path} className="ims-tab">
                {t(link.label)}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="nav:hidden">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-12 w-full items-center justify-between gap-3 text-start text-sm font-medium text-heading"
          >
            <span className="min-w-0">
              <span className="text-muted">{t('admin.nav.menu')}: </span>
              {current ? t(current.label) : ''}
            </span>
            <span
              aria-hidden="true"
              className={`flex-none text-muted transition-transform ${open ? 'rotate-180' : ''}`}
            >
              ▾
            </span>
          </button>
          {open && (
            <ul id={menuId} className="flex flex-col gap-1 pb-3">
              {links.map((link) => (
                <li key={link.path}>
                  <NavLink
                    to={link.path}
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center rounded-control px-3 text-sm font-medium text-body hover:bg-surface-subtle aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary"
                  >
                    {t(link.label)}
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </nav>
  );
}

/** Page title row with the primary action at the end. */
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <h1 className="ims-page-title">{title}</h1>
      {children}
    </div>
  );
}

let preloaded = false;

function preloadAdminPages() {
  if (preloaded) return;
  preloaded = true;
  const load = () => {
    void import('./FieldsPage');
    void import('./CriteriaPage');
    void import('./UsersPage');
    void import('./AcceptedTraineesPage');
    void import('./ReportsPage');
    void import('../../reports/MonthlyReport');
    void import('../../reports/FieldsReport');
    void import('./SettingsPage');
    void import('./certificate/CertificateTemplatePage');
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(load);
  else setTimeout(load, 200);
}
