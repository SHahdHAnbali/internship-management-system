import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';
import { hrApi } from './hrApi';
import type { ApplicationStatus, HrApplication } from './models';

const STATUSES: ApplicationStatus[] = ['Submitted', 'UnderReview', 'Accepted', 'Rejected'];

/** HR: training applications, newest decisions to make first; filter by status (owner decision 2026-10-29). */
export function ApplicationsPage() {
  const { t, language } = useI18n();
  const id = useId();
  const [status, setStatus] = useState<ApplicationStatus | ''>('Submitted');
  const [applications, setApplications] = useState<HrApplication[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    hrApi.applications(status).then(
      (list) => {
        setApplications(list);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [status]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="ims-page-title">{t('hr.applications.title')}</h1>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-status`}>
            {t('hr.applications.status')}
          </label>
          <select
            id={`${id}-status`}
            className="ims-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as ApplicationStatus | '')}
          >
            <option value="">{t('hr.applications.all')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`training.applicationStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {failed ? (
        <p className="ims-state">{t('training.errors.loadFailed')}</p>
      ) : applications?.length === 0 ? (
        <p className="ims-state">{t('hr.applications.empty')}</p>
      ) : (
        applications && (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('training.profile.fullName')}</th>
                  <th scope="col">{t('training.fields.field')}</th>
                  <th scope="col">{t('training.profile.university')}</th>
                  <th scope="col">{t('training.fields.submittedAt')}</th>
                  <th scope="col">{t('hr.applications.status')}</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link to={`/hr/applications/${a.id}`} className="font-semibold">
                        {a.trainee.fullName ?? a.trainee.email}
                      </Link>
                    </td>
                    <td>{a.field.name}</td>
                    <td>{a.trainee.university}</td>
                    <td>{new Date(a.submittedAt).toLocaleDateString(language)}</td>
                    <td>
                      <span className="ims-badge">
                        {t(`training.applicationStatus.${a.status}`)}
                      </span>
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
