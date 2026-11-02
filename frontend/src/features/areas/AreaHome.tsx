import { AreaShell } from '../../components/AreaShell';
import { useAuth } from '../../auth/context';
import { useI18n } from '../../i18n/context';

/**
 * The account page of an ordinary Google user without a role (`account`): only the signed-in user's own account and
 * sign-out. (The Trainee, Employee and HR areas have their own pages.)
 */
export function AreaHome({ area }: { area: 'account' }) {
  const { t } = useI18n();
  const { user } = useAuth();

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
      <p className="ims-state mt-8">{t('areas.accountNoAccess')}</p>
    </AreaShell>
  );
}
