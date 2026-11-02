import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { useAdminFeedback } from './feedback';
import { useLoad } from './useLoad';

/**
 * Admin: the accepted trainees (PDF §2), read-only. Each accepted application with the trainee's profile, the requested
 * period and the assignments recorded for it, exactly as stored.
 */
export function AcceptedTraineesPage() {
  const { t, language } = useI18n();
  const feedback = useAdminFeedback();
  const {
    data: trainees,
    loading,
    failed,
  } = useLoad('accepted-trainees', adminApi.listAcceptedTrainees, feedback.error);
  const date = (value: string) => new Date(value).toLocaleDateString(language);

  return (
    <>
      <PageHeader title={t('admin.acceptedTrainees.title')} />

      {failed ? (
        <p className="ims-state">{t('admin.errors.loadFailed')}</p>
      ) : !loading && trainees?.length === 0 ? (
        <p className="ims-state">{t('admin.acceptedTrainees.empty')}</p>
      ) : (
        trainees && (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('training.profile.fullName')}</th>
                  <th scope="col">{t('training.fields.field')}</th>
                  <th scope="col">{t('training.profile.university')}</th>
                  <th scope="col">{t('training.profile.major')}</th>
                  <th scope="col">{t('training.fields.period')}</th>
                  <th scope="col">{t('admin.acceptedTrainees.hours')}</th>
                  <th scope="col">{t('admin.acceptedTrainees.acceptedAt')}</th>
                  <th scope="col">{t('admin.acceptedTrainees.assignments')}</th>
                </tr>
              </thead>
              <tbody>
                {trainees.map((a) => (
                  <tr key={a.applicationId}>
                    <td className="font-semibold">{a.trainee.fullName}</td>
                    <td>{a.fieldName}</td>
                    <td>{a.trainee.university}</td>
                    <td>{a.trainee.major}</td>
                    <td>
                      {date(a.availableFrom)} – {date(a.availableTo)}
                    </td>
                    <td>{a.hours}</td>
                    <td>{a.acceptedAt && date(a.acceptedAt)}</td>
                    <td>
                      {a.assignments.length === 0 ? (
                        <span className="text-muted">
                          {t('admin.acceptedTrainees.noAssignment')}
                        </span>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {a.assignments.map((s) => (
                            <li key={`${s.employeeName}-${s.startDate}`}>
                              {s.employeeName}{' '}
                              <span className="ims-badge">
                                {t(`training.assignmentStatus.${s.status}`)}
                              </span>
                              <span className="block text-small text-muted">
                                {date(s.startDate)} – {date(s.endDate)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
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
