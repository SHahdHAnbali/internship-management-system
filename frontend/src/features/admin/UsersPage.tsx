import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { useAdminFeedback } from './feedback';
import { STAFF_ROLES, type User, type UserRole } from './models';
import { useLoad } from './useLoad';

/**
 * Admin: users and their roles (PDF §2, §4). Staff accounts are created as Employee on first Google sign-in;
 * the Admin grants higher roles here.
 */
export function UsersPage() {
  const { t } = useI18n();
  const feedback = useAdminFeedback();
  const {
    data: users,
    setData,
    loading,
    failed,
    reload,
  } = useLoad('users', adminApi.listUsers, feedback.error);

  const changeRole = async (user: User, role: UserRole) => {
    try {
      const updated = await adminApi.changeUserRole(user.id, role);
      setData((current) => current?.map((u) => (u.id === updated.id ? updated : u)) ?? null);
      feedback.saved();
    } catch (error) {
      feedback.error(error);
      await reload();
    }
  };

  return (
    <>
      <PageHeader title={t('admin.users.title')} />

      {failed ? (
        <p className="ims-state">{t('admin.errors.loadFailed')}</p>
      ) : !loading && users?.length === 0 ? (
        <p className="ims-state">{t('admin.users.empty')}</p>
      ) : (
        users && (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.users.name')}</th>
                  <th scope="col">{t('admin.users.email')}</th>
                  <th scope="col">{t('admin.users.department')}</th>
                  <th scope="col">{t('admin.users.role')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.fullName}</td>
                    <td dir="ltr" className="text-start">
                      {user.email}
                    </td>
                    <td className="text-muted!">{user.department}</td>
                    <td>
                      <select
                        className="ims-input h-10 w-44 py-0"
                        aria-label={`${t('admin.users.role')}: ${user.fullName}`}
                        value={user.role}
                        onChange={(e) => void changeRole(user, e.target.value as UserRole)}
                      >
                        {STAFF_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(`roles.${role}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}
