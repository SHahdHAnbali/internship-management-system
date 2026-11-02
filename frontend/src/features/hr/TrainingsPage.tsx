import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';
import { hrApi } from './hrApi';
import type { HrAssignment } from './models';

/**
 * HR: the trainings (assignments) as recorded, read-only (PDF §4 "running training"). Current = Active (AD-49); every
 * other status is listed as previous. Extending, ending, transferring or withdrawing is not built.
 */
export function TrainingsPage() {
  const { t } = useI18n();
  const [assignments, setAssignments] = useState<HrAssignment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    hrApi.assignments().then(setAssignments, () => setFailed(true));
  }, []);

  if (failed) return <p className="ims-state">{t('training.errors.loadFailed')}</p>;
  if (!assignments) return null;

  const current = assignments.filter((a) => a.status === 'Active');
  const previous = assignments.filter((a) => a.status !== 'Active');

  return (
    <>
      <h1 className="ims-page-title mb-8">{t('hr.trainings.title')}</h1>
      <TrainingTable
        id="current-trainings"
        title={t('hr.trainings.current')}
        empty={t('hr.trainings.noCurrent')}
        rows={current}
      />
      <TrainingTable
        id="previous-trainings"
        title={t('hr.trainings.previous')}
        empty={t('hr.trainings.noPrevious')}
        rows={previous}
      />
    </>
  );
}

function TrainingTable({
  id,
  title,
  empty,
  rows,
}: {
  id: string;
  title: string;
  empty: string;
  rows: HrAssignment[];
}) {
  const { t, language } = useI18n();
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  return (
    <section aria-labelledby={id} className="mb-10">
      <h2 id={id} className="mb-4 text-h3 font-semibold text-heading">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="ims-state">{empty}</p>
      ) : (
        <div className="ims-table-card">
          <table className="ims-table">
            <thead>
              <tr>
                <th scope="col">{t('hr.trainings.trainee')}</th>
                <th scope="col">{t('hr.trainings.mentor')}</th>
                <th scope="col">{t('training.fields.field')}</th>
                <th scope="col">{t('hr.mentorRequests.startDate')}</th>
                <th scope="col">{t('hr.mentorRequests.endDate')}</th>
                <th scope="col">{t('hr.trainings.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link
                      to={`/hr/reports/trainee-history?trainee=${a.trainee.id}`}
                      className="font-semibold"
                    >
                      {a.trainee.fullName ?? a.trainee.email}
                    </Link>
                  </td>
                  <td>{a.employee.fullName}</td>
                  <td>{a.fieldName}</td>
                  <td>{date(a.startDate)}</td>
                  <td>{date(a.endDate)}</td>
                  <td>
                    <span className="ims-badge">{t(`training.assignmentStatus.${a.status}`)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
