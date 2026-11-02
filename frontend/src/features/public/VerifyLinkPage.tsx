import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/context';
import { homeFor } from '../../auth/models';
import { useI18n } from '../../i18n/context';
import { signInErrorKey } from './authErrors';

/** Opens the one-time sign-in link e-mailed to a trainee (`/sign-in/verify?token=…`). */
export function VerifyLinkPage() {
  const { t } = useI18n();
  const { verifyTraineeLink } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [failure, setFailure] = useState<string | null>(null);
  const error = token ? failure : 'auth.errors.invalidCode';
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return; // the token is single-use: verify it exactly once
    started.current = true;
    verifyTraineeLink(token).then(
      (user) => navigate(homeFor(user), { replace: true }),
      (e: unknown) => setFailure(signInErrorKey(e)),
    );
  }, [token, verifyTraineeLink, navigate]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-gutter">
      <div className="ims-card w-full max-w-md text-center" role="status">
        {error ? (
          <>
            <h1 className="text-h2 font-bold text-heading">{t('auth.link.failedTitle')}</h1>
            <p className="mt-3 text-muted">{t(error)}</p>
            <Link to="/sign-in" className="ims-btn-primary mt-6">
              {t('auth.link.back')}
            </Link>
          </>
        ) : (
          <p className="text-muted">{t('auth.link.verifying')}</p>
        )}
      </div>
    </main>
  );
}
