import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { hrApi } from './hrApi';
import type { HrTrainee, TraineeHistory } from './models';

/**
 * HR report «سجل المتدرب» (PDF §6): all trainings of one selected trainee and the contact notes kept with them, read-only
 * and as recorded. Trainings are the trainee's assignments; contact notes are the contact-log entries of their
 * applications. Only trainees with at least one Accepted application can be chosen (owner decision 2026-11-02); the API
 * enforces it for the list and for a trainee given in the address.
 */
export function TraineeHistoryReport() {
  const { t } = useI18n();
  const id = useId();
  const [params, setParams] = useSearchParams();
  const selected = params.get('trainee') ?? '';
  const [trainees, setTrainees] = useState<HrTrainee[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    hrApi.trainees().then(setTrainees, () => setFailed(true));
  }, []);

  return (
    <>
      <Link to="/hr/reports" className="ims-btn-text mb-4 inline-flex">
        {t('hr.reports.back')}
      </Link>
      <h1 className="ims-page-title mb-2">{t('hr.reports.traineeHistory.title')}</h1>
      <p className="mb-8 text-muted">{t('hr.reports.traineeHistory.description')}</p>

      {failed ? (
        <p className="ims-state">{t('training.errors.loadFailed')}</p>
      ) : trainees?.length === 0 ? (
        <p className="ims-state">{t('hr.reports.traineeHistory.noTrainees')}</p>
      ) : (
        trainees && (
          <>
            <div className="mb-8 flex max-w-md flex-col gap-1">
              <label className="ims-label" htmlFor={`${id}-trainee`}>
                {t('hr.reports.traineeHistory.trainee')}
              </label>
              <select
                id={`${id}-trainee`}
                className="ims-input"
                value={selected}
                onChange={(e) => setParams(e.target.value ? { trainee: e.target.value } : {})}
              >
                <option value="">{t('hr.reports.traineeHistory.choose')}</option>
                {trainees.map((trainee) => (
                  <option key={trainee.id} value={trainee.id}>
                    {trainee.fullName ?? trainee.email}
                  </option>
                ))}
              </select>
            </div>
            {selected && <Report key={selected} traineeId={selected} />}
          </>
        )
      )}
    </>
  );
}

function Report({ traineeId }: { traineeId: string }) {
  const { t, language } = useI18n();
  const [history, setHistory] = useState<TraineeHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hrApi
      .traineeHistory(traineeId)
      .then(setHistory, (failure: unknown) =>
        setError(
          failure instanceof ApiError && (failure.status === 404 || failure.status === 400)
            ? 'hr.reports.traineeHistory.notFound'
            : 'training.errors.loadFailed',
        ),
      );
  }, [traineeId]);

  if (error) return <p className="ims-state">{t(error)}</p>;
  if (!history) return null;

  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const trainings = history.applications.flatMap((a) =>
    a.assignments.map((s) => ({ ...s, fieldName: a.fieldName })),
  );
  const notes = history.applications
    .flatMap((a) => a.contactLogs.map((l) => ({ ...l, fieldName: a.fieldName })))
    .sort(
      (x, y) =>
        y.contactDate.localeCompare(x.contactDate) || y.recordedAt.localeCompare(x.recordedAt),
    );

  return (
    <div className="flex flex-col gap-10">
      <p className="text-h3 font-semibold text-heading">
        {history.trainee.fullName ?? history.trainee.email}
      </p>

      <section aria-labelledby="report-trainings">
        <h2 id="report-trainings" className="mb-4 text-h3 font-semibold text-heading">
          {t('hr.reports.traineeHistory.trainings')}
        </h2>
        {trainings.length === 0 ? (
          <p className="ims-state">{t('hr.reports.traineeHistory.noTrainings')}</p>
        ) : (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('training.fields.field')}</th>
                  <th scope="col">{t('hr.trainings.mentor')}</th>
                  <th scope="col">{t('hr.mentorRequests.startDate')}</th>
                  <th scope="col">{t('hr.mentorRequests.endDate')}</th>
                  <th scope="col">{t('hr.trainings.status')}</th>
                  <th scope="col">{t('hr.reports.traineeHistory.endReason')}</th>
                </tr>
              </thead>
              <tbody>
                {trainings.map((s) => (
                  <tr key={s.id}>
                    <td>{s.fieldName}</td>
                    <td>{s.employeeName}</td>
                    <td>{date(s.startDate)}</td>
                    <td>{date(s.endDate)}</td>
                    <td>
                      <span className="ims-badge">
                        {t(`training.assignmentStatus.${s.status}`)}
                      </span>
                    </td>
                    <td>{s.endReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="report-notes">
        <h2 id="report-notes" className="mb-4 text-h3 font-semibold text-heading">
          {t('hr.reports.traineeHistory.contactNotes')}
        </h2>
        {notes.length === 0 ? (
          <p className="ims-state">{t('hr.reports.traineeHistory.noContactNotes')}</p>
        ) : (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('hr.contactLog.date')}</th>
                  <th scope="col">{t('hr.contactLog.method')}</th>
                  <th scope="col">{t('hr.contactLog.summary')}</th>
                  <th scope="col">{t('hr.reports.traineeHistory.author')}</th>
                  <th scope="col">{t('training.fields.field')}</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((l) => (
                  <tr key={l.id}>
                    <td>{date(l.contactDate)}</td>
                    <td>{t(`hr.contactLog.methods.${l.method}`)}</td>
                    <td className="whitespace-pre-line">{l.summary}</td>
                    <td>{l.authorName}</td>
                    <td>{l.fieldName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
