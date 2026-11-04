import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { ExportButtons } from '../../reports/export/ExportButtons';
import { fileDate } from '../../reports/export/files';
import { fileNamePart, type ExportDocument } from '../../reports/export/model';
import { hrApi } from './hrApi';
import type { HrTrainee, TraineeHistory } from './models';

/**
 * HR report «سجل المتدرب» (PDF §6): all trainings of one selected trainee and the contact notes kept with them, read-only
 * and as recorded. Trainings are the trainee's assignments; contact notes are the contact-log entries of their
 * applications. Only trainees with at least one Accepted application can be chosen (owner decision 2026-11-02); the API
 * enforces it for the list and for a trainee given in the address. The trainings can be filtered by period (recorded
 * dates overlapping it, both ends included) and field (PDF §6); the contact notes are always shown in full.
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function Report({ traineeId }: { traineeId: string }) {
  const { t, language } = useI18n();
  const id = useId();
  const [params, setParams] = useSearchParams();
  // The trainings filters (PDF §6 "filtered by period and field"), kept in the address. Malformed values are ignored.
  const from = DATE.test(params.get('from') ?? '') ? params.get('from')! : '';
  const to = DATE.test(params.get('to') ?? '') ? params.get('to')! : '';
  const fieldId = params.get('field') ?? '';
  const periodInvalid = Boolean(from && to && to < from);
  const until = periodInvalid ? '' : to; // an end before the start is flagged and not applied
  const filtered = Boolean(from || until || fieldId);
  const key = `${traineeId}|${from}|${until}|${fieldId}`;

  // The latest answer and the filters it was for. Contact notes and the field choices never depend on the filters, so
  // they stay shown while the trainings of new filters load.
  const [history, setHistory] = useState<{ key: string; data: TraineeHistory } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    hrApi.traineeHistory(traineeId, { from, to: until, fieldId }).then(
      (data) => {
        if (!current) return;
        setHistory({ key, data });
        setError(null);
      },
      (failure: unknown) =>
        current &&
        setError(
          failure instanceof ApiError && (failure.status === 404 || failure.status === 400)
            ? 'hr.reports.traineeHistory.notFound'
            : 'training.errors.loadFailed',
        ),
    );
    return () => {
      current = false;
    };
  }, [traineeId, from, until, fieldId, key]);

  // Filters are offered only when the trainee has two trainings or more in all (the unfiltered total from the API, so
  // narrowing them down never hides the filters). With fewer, any filters in the address are dropped so that every
  // training is shown.
  const fewTrainings = history ? history.data.totalTrainings < 2 : false;
  const filtersInAddress = ['from', 'to', 'field'].some((name) => params.has(name));
  useEffect(() => {
    if (!fewTrainings || !filtersInAddress) return;
    const next = new URLSearchParams(params);
    for (const name of ['from', 'to', 'field']) next.delete(name);
    setParams(next, { replace: true });
  }, [fewTrainings, filtersInAddress, params, setParams]);

  if (error) return <p className="ims-state">{t(error)}</p>;
  if (!history) return null;

  const setFilter = (name: 'from' | 'to' | 'field', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };
  const fields = [
    ...new Map(history.data.applications.map((a) => [a.fieldId, a.fieldName])).entries(),
  ];
  const trainingsShown = history.key === key && !(fewTrainings && filtersInAddress);

  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const trainings = history.data.applications.flatMap((a) =>
    a.assignments.map((s) => ({ ...s, fieldName: a.fieldName })),
  );
  const notes = history.data.applications
    .flatMap((a) => a.contactLogs.map((l) => ({ ...l, fieldName: a.fieldName })))
    .sort(
      (x, y) =>
        y.contactDate.localeCompare(x.contactDate) || y.recordedAt.localeCompare(x.recordedAt),
    );

  const traineeName = history.data.trainee.fullName ?? history.data.trainee.email;

  /**
   * Exactly what the page shows: the trainings as filtered (with the filters in use) and every contact note (never
   * filtered).
   */
  const exportDocument = (): ExportDocument | null => {
    if (!trainingsShown) return null;
    const fieldName = fields.find(([value]) => value === fieldId)?.[1];
    const details = [`${t('hr.reports.traineeHistory.trainee')}: ${traineeName}`];
    if (from) details.push(`${t('hr.reports.traineeHistory.from')}: ${date(from)}`);
    if (until) details.push(`${t('hr.reports.traineeHistory.to')}: ${date(until)}`);
    if (fieldName) details.push(`${t('training.fields.field')}: ${fieldName}`);
    if (filtered) details.push(t('hr.reports.traineeHistory.filtersHint'));
    return {
      title: t('hr.reports.traineeHistory.title'),
      details,
      generated: t('reports.export.generated', { date: new Date().toLocaleString(language) }),
      direction: language === 'ar' ? 'rtl' : 'ltr',
      language,
      fileName: `ims-trainee-history-${fileNamePart(traineeName)}-${fileDate()}`,
      sections: [
        {
          heading: t('hr.reports.traineeHistory.trainings'),
          columns: [
            { label: t('training.fields.field'), width: 1.5 },
            { label: t('hr.trainings.mentor'), width: 1.5 },
            { label: t('hr.mentorRequests.startDate') },
            { label: t('hr.mentorRequests.endDate') },
            { label: t('hr.trainings.status') },
            { label: t('hr.reports.traineeHistory.endReason'), width: 2 },
          ],
          rows: trainings.map((s) => [
            s.fieldName,
            s.employeeName,
            date(s.startDate),
            date(s.endDate),
            t(`training.assignmentStatus.${s.status}`),
            s.endReason ?? '—',
          ]),
          empty: t(
            filtered
              ? 'hr.reports.traineeHistory.noMatchingTrainings'
              : 'hr.reports.traineeHistory.noTrainings',
          ),
        },
        {
          heading: t('hr.reports.traineeHistory.contactNotes'),
          columns: [
            { label: t('hr.contactLog.date') },
            { label: t('hr.contactLog.method') },
            { label: t('hr.contactLog.summary'), width: 4 },
            { label: t('hr.reports.traineeHistory.author'), width: 1.5 },
            { label: t('training.fields.field'), width: 1.5 },
          ],
          rows: notes.map((l) => [
            date(l.contactDate),
            t(`hr.contactLog.methods.${l.method}`),
            l.summary,
            l.authorName,
            l.fieldName,
          ]),
          empty: t('hr.reports.traineeHistory.noContactNotes'),
        },
      ],
    };
  };

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-h3 font-semibold text-heading">{traineeName}</p>
        <ExportButtons build={exportDocument} disabled={!trainingsShown} />
      </div>

      <section aria-labelledby="report-trainings">
        <h2 id="report-trainings" className="mb-4 text-h3 font-semibold text-heading">
          {t('hr.reports.traineeHistory.trainings')}
        </h2>
        {!fewTrainings && (
          <>
            <form
              role="search"
              aria-label={t('hr.reports.traineeHistory.filters')}
              aria-describedby={`${id}-filters-hint`}
              className="mb-2 grid gap-4 sm:grid-cols-3"
              onSubmit={(event) => event.preventDefault()}
            >
              <div className="flex flex-col gap-1">
                <label className="ims-label" htmlFor={`${id}-from`}>
                  {t('hr.reports.traineeHistory.from')}
                </label>
                <input
                  id={`${id}-from`}
                  type="date"
                  className="ims-input"
                  value={from}
                  onChange={(e) => setFilter('from', e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="ims-label" htmlFor={`${id}-to`}>
                  {t('hr.reports.traineeHistory.to')}
                </label>
                <input
                  id={`${id}-to`}
                  type="date"
                  className="ims-input"
                  value={to}
                  min={from || undefined}
                  aria-invalid={periodInvalid}
                  aria-describedby={periodInvalid ? `${id}-to-error` : undefined}
                  onChange={(e) => setFilter('to', e.target.value)}
                />
                {periodInvalid && (
                  <p id={`${id}-to-error`} className="ims-error">
                    {t('hr.reports.traineeHistory.periodInvalid')}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label className="ims-label" htmlFor={`${id}-field`}>
                  {t('training.fields.field')}
                </label>
                <select
                  id={`${id}-field`}
                  className="ims-input"
                  value={fieldId}
                  onChange={(e) => setFilter('field', e.target.value)}
                >
                  <option value="">{t('hr.reports.traineeHistory.allFields')}</option>
                  {fields.map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </form>
            <p id={`${id}-filters-hint`} className="mb-4 text-small text-muted">
              {t('hr.reports.traineeHistory.filtersHint')}
            </p>
          </>
        )}
        {!trainingsShown ? (
          <p className="ims-state" role="status">
            {t('common.loading')}
          </p>
        ) : trainings.length === 0 ? (
          <p className="ims-state">
            {t(
              filtered
                ? 'hr.reports.traineeHistory.noMatchingTrainings'
                : 'hr.reports.traineeHistory.noTrainings',
            )}
          </p>
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
