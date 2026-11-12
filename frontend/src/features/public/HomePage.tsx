import { Link } from 'react-router';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { Logo } from '../../components/Logo';
import { useI18n } from '../../i18n/context';

/**
 * Public homepage: introduces the internship program (requirements PDF §1, §4 "Trainee"). "Sign in" opens the
 * sign-in page, from which a trainee reaches the application form.
 */
const YEAR = new Date().getFullYear();

export function HomePage() {
  const { t } = useI18n();

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="border-b border-divider bg-surface">
        <div className="mx-auto flex min-h-header max-w-content items-center justify-between gap-2 px-gutter sm:gap-4">
          <Link to="/" className="flex-none py-2" aria-label={t('home.logoAlt')}>
            <Logo />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <LanguageSwitch />
            <Link to="/sign-in" className="ims-btn-outline">
              {t('home.signIn')}
            </Link>
          </div>
        </div>
      </header>

      <main className="flex flex-1 items-center">
        <section
          className="mx-auto w-full max-w-content px-gutter py-16 text-center sm:py-24"
          aria-labelledby="home-title"
        >
          <span className="ims-badge">{t('app.title')}</span>
          <h1
            id="home-title"
            className="mx-auto mt-6 max-w-3xl text-display font-bold tracking-[-0.02em] text-heading"
          >
            {t('home.titleStart')}
            <span className="text-brand">{t('home.titleAccent')}</span>
            {t('home.titleEnd')}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted">
            {t('home.description')}
          </p>
        </section>
      </main>

      <footer className="border-t border-divider">
        <div className="mx-auto flex max-w-content flex-col items-center justify-between gap-3 px-gutter py-6 text-small text-muted sm:flex-row">
          <Logo className="h-8 w-auto" decorative />
          <p className="text-center sm:text-start">
            © {YEAR} ProGineer Technologies · {t('app.title')}
          </p>
        </div>
      </footer>
    </div>
  );
}
