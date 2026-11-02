import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/context';
import { authApi } from '../../auth/authApi';
import { renderGoogleButton } from '../../auth/googleIdentity';
import { homeFor, type AuthConfig, type SessionUser } from '../../auth/models';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { Logo } from '../../components/Logo';
import { useI18n } from '../../i18n/context';
import { signInErrorKey } from './authErrors';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sign-in (PDF §2, §9). Company staff: Google only, company domain enforced by the API. Trainees: e-mail → one-time
 * 6-digit code (or the e-mailed link), valid 15 minutes, no password. Each user then lands in their role's area.
 */
export function SignInPage() {
  const { t, language } = useI18n();
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const googleHost = useRef<HTMLDivElement>(null);

  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [traineeError, setTraineeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    authApi
      .config()
      .then(setConfig)
      .catch(() =>
        setConfig({
          googleClientId: null,
          googleHostedDomains: null,
          traineeCodeLifetimeMinutes: 15,
        }),
      );
  }, []);

  const goHome = (user: SessionUser) => {
    const home = homeFor(user);
    const returnUrl = params.get('returnUrl');
    navigate(returnUrl?.startsWith(home) ? returnUrl : home, { replace: true });
  };

  const onGoogleCredential = useEffectEvent((idToken: string) => {
    setStaffError(null);
    auth
      .signInWithGoogle(idToken)
      .then(goHome, (error: unknown) => setStaffError(signInErrorKey(error)));
  });

  // Google's button, re-rendered when the language changes.
  useEffect(() => {
    const host = googleHost.current;
    if (!config?.googleClientId || !host) return;
    renderGoogleButton(
      host,
      {
        clientId: config.googleClientId,
        locale: language,
      },
      (idToken) => onGoogleCredential(idToken),
    ).catch(() => setStaffError('auth.errors.googleUnavailable'));
  }, [config, language]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setTraineeError(null);
    try {
      await action();
    } catch (error) {
      setTraineeError(signInErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const emailInvalid = !EMAIL_PATTERN.test(email.trim());
  const codeInvalid = !/^\d{6}$/.test(code.trim());

  const requestCode = (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (emailInvalid) return;
    void run(async () => {
      await auth.requestTraineeCode(email.trim());
      setCode('');
      setTouched(false);
      setStep('code');
    });
  };

  const verifyCode = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (codeInvalid) return;
    void run(async () => goHome(await auth.verifyTraineeCode(email.trim(), code.trim())));
  };

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="border-b border-divider bg-surface">
        <div className="mx-auto flex min-h-header max-w-content items-center justify-between gap-2 px-gutter sm:gap-4">
          <Link to="/" className="flex-none py-2" aria-label={t('home.logoAlt')}>
            <Logo />
          </Link>
          <LanguageSwitch />
        </div>
      </header>

      <main className="flex flex-1 justify-center px-gutter py-12 sm:py-20">
        <div className="w-full max-w-[22rem]">
          <h1 className="text-h1 font-bold tracking-[-0.02em] text-heading">{t('auth.title')}</h1>

          {/* Company staff: Google is the only external provider (PDF §2). */}
          <section className="mt-8" aria-label={t('auth.staff.label')}>
            {config?.googleClientId ? (
              <div ref={googleHost} className="flex h-11 w-full justify-center overflow-hidden" />
            ) : (
              <button
                type="button"
                className="ims-btn-outline h-11 w-full rounded-lg text-base"
                aria-disabled="true"
                aria-describedby="google-status"
              >
                <GoogleMark />
                Google
              </button>
            )}
            {config && !config.googleClientId && (
              <p id="google-status" className="mt-2 text-center text-small text-muted">
                {t('auth.staff.notConfigured')}
              </p>
            )}
            {staffError && (
              <p className="ims-error mt-2 text-center" role="alert">
                {t(staffError)}
              </p>
            )}
          </section>

          <div
            className="my-7 flex items-center gap-4 text-small font-semibold tracking-wider text-muted uppercase"
            aria-hidden="true"
          >
            <span className="h-px flex-1 bg-divider" />
            {t('auth.or')}
            <span className="h-px flex-1 bg-divider" />
          </div>

          {/* Trainees: one-time code by e-mail, no password. */}
          {step === 'email' ? (
            <form
              className="flex flex-col"
              onSubmit={requestCode}
              noValidate
              aria-label={t('auth.trainee.label')}
            >
              <label htmlFor="email" className="ims-label text-base">
                {t('auth.trainee.email')}
              </label>
              <input
                id="email"
                type="email"
                dir="ltr"
                autoComplete="email"
                className="ims-input mt-2 rounded-lg text-start"
                value={email}
                maxLength={320}
                aria-invalid={touched && emailInvalid}
                aria-describedby={touched && emailInvalid ? 'email-error' : 'email-hint'}
                onChange={(e) => setEmail(e.target.value)}
              />
              {touched && emailInvalid ? (
                <p id="email-error" className="ims-error mt-2">
                  {t('auth.errors.invalidEmail')}
                </p>
              ) : (
                <p id="email-hint" className="ims-hint mt-2">
                  {t('auth.trainee.hint')}
                </p>
              )}
              <button type="submit" className="ims-signin-submit mt-6" disabled={busy}>
                {t('auth.trainee.sendCode')}
              </button>
            </form>
          ) : (
            <form
              className="flex flex-col"
              onSubmit={verifyCode}
              noValidate
              aria-label={t('auth.trainee.label')}
            >
              <p className="text-muted">
                {t('auth.trainee.codeSent')}{' '}
                <span dir="ltr" className="font-semibold text-heading">
                  {email.trim()}
                </span>
                .{' '}
                {t('auth.trainee.codeValidity', {
                  minutes: config?.traineeCodeLifetimeMinutes ?? 15,
                })}
              </p>
              <label htmlFor="code" className="ims-label mt-6 text-base">
                {t('auth.trainee.code')}
              </label>
              <input
                id="code"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                className="ims-input mt-2 rounded-lg text-center text-lg tracking-[0.4em]"
                value={code}
                aria-invalid={touched && codeInvalid}
                aria-describedby={touched && codeInvalid ? 'code-error' : undefined}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              {touched && codeInvalid && (
                <p id="code-error" className="ims-error mt-2">
                  {t('auth.errors.codeFormat')}
                </p>
              )}
              <button type="submit" className="ims-signin-submit mt-6" disabled={busy}>
                {t('auth.trainee.signIn')}
              </button>
              <p className="mt-6 text-center text-muted">
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  disabled={busy}
                  onClick={() => {
                    setTraineeError(null);
                    setTouched(false);
                    setStep('email');
                  }}
                >
                  {t('auth.trainee.changeEmail')}
                </button>
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  disabled={busy}
                  onClick={() => requestCode()}
                >
                  {t('auth.trainee.resend')}
                </button>
              </p>
            </form>
          )}

          {traineeError && (
            <p className="ims-error mt-4 text-center" role="alert">
              {t(traineeError)}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

/** Google "G" mark, shown only on the disabled placeholder when Google sign-in isn't configured. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-5">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
