import { useCallback, useState } from 'react';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { useAdminFeedback } from './feedback';
import type { AcceptedTrainee } from './models';
import { ResponsibleHrDialog } from './ResponsibleHrDialog';
import { useLoad } from './useLoad';

/**
 * Admin: the accepted trainees (PDF §2). Each accepted application with the trainee's profile, the requested period and
 * the assignments recorded for it, exactly as stored, and its responsible HR (AD-64): the Admin may appoint a
 * replacement, for example when the responsible HR no longer holds the HR role.
 */
export function AcceptedTraineesPage() {
  const { t, language } = useI18n();
  const feedback = useAdminFeedback();
  const {
    data: trainees,
    setData,
    loading,
    failed,
    reload,
  } = useLoad('accepted-trainees', adminApi.listAcceptedTrainees, feedback.error);
  const [changing, setChanging] = useState<AcceptedTrainee | null>(null);
  const date = (value: string) => new Date(value).toLocaleDateString(language);

  const saved = (updated: AcceptedTrainee) => {
    setData(
      (current) =>
        current?.map((a) => (a.applicationId === updated.applicationId ? updated : a)) ?? null,
    );
    setChanging(null);
    feedback.saved();
  };
  const failedToSave = useCallback(
    (error: unknown) => {
      setChanging(null);
      feedback.error(error);
      void reload();
    },
    [feedback, reload],
  );

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
                  <th scope="col">{t('admin.acceptedTrainees.responsibleHr')}</th>
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
                    <td>
                      <span className="block">
                        {a.responsibleHr.current.fullName}{' '}
                        {!a.responsibleHr.current.isHr && (
                          <span className="ims-badge">{t('admin.acceptedTrainees.notHr')}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        className="ims-btn-text"
                        aria-label={t('admin.acceptedTrainees.changeFor', {
                          name: a.trainee.fullName ?? '',
                        })}
                        onClick={() => setChanging(a)}
                      >
                        {t('admin.acceptedTrainees.change')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {changing && (
        <ResponsibleHrDialog
          trainee={changing}
          onSaved={saved}
          onFailed={failedToSave}
          onClose={() => setChanging(null)}
        />
      )}
    </>
  );
}
