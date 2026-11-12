import { useNavigate } from 'react-router';
import { AreaShell } from '../../components/AreaShell';
import { useAuth } from '../../auth/context';
import { SIGNING_OUT } from '../../auth/models';
import { useI18n } from '../../i18n/context';

/**
 * The account page of an ordinary Google user without a role (`account`; AD-42 as amended 2026-11-12, B3): a Google
 * account outside the staff domains that matches no trainee. It explains that a first-time trainee registers with the
 * e-mailed code (after which Google works with the same address), and offers the e-mail sign-in, which ends this
 * Google session first (the sign-in page is for signed-out users).
 */
export function AreaHome({ area }: { area: 'account' }) {
  const { t } = useI18n();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <AreaShell>
      <h1 className="ims-page-title">{t(`areas.${area}`)}</h1>
      {user && (
        <p className="mt-2 text-muted">
          {t('auth.signedInAs')}{' '}
          <span className="font-semibold text-heading">{user.name ?? user.email}</span>
          {user.name && <span dir="ltr"> ({user.email})</span>}
        </p>
      )}
      <div className="ims-state mt-8 flex flex-col items-center gap-4">
        <p>{t('areas.accountNoAccess')}</p>
        <button
          type="button"
          className="ims-btn-primary"
          onClick={async () => {
            // Leave for the sign-in page first, marked as signing out, so it is not redirected back here.
            navigate('/sign-in', { replace: true, state: SIGNING_OUT });
            await signOut();
          }}
        >
          {t('areas.accountUseEmail')}
        </button>
      </div>
    </AreaShell>
  );
}
