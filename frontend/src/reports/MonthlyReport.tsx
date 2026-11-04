import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useI18n } from '../i18n/context';
import { ExportButtons } from './export/ExportButtons';
import type { ExportDocument } from './export/model';
import {
  monthlyReportApi,
  type MonthlyReport as Report,
  type MonthlyReportFilters,
  type ReportArea,
} from './monthlyReportApi';

const MONTH = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/;

/** The current calendar month on this device, `YYYY-MM`. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** A recorded calendar date (`YYYY-MM-DD`) shown as that same day, whatever the device's time zone. */
function formatDate(value: string, language: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { timeZone: 'UTC' });
}

/**
 * The monthly report (PDF §6 «التقرير الشهري», for HR and the Admin): everyone who was training during the chosen
 * month, with whom, in which field, from when to when. Read-only and as recorded: every assignment whose dates overlap
 * the month (PDF technical note), so a trainee moved between employees shows as two rows. Filtered by field and
 * employee; the choices are kept in the address so the report can be reloaded or shared.
 */
export function MonthlyReport({ area, backTo }: { area: ReportArea; backTo: string }) {
  const { t, language } = useI18n();
  const id = useId();
  const [params, setParams] = useSearchParams();
  const month = MONTH.test(params.get('month') ?? '') ? params.get('month')! : currentMonth();
  const fieldId = params.get('field') ?? '';
  const employeeId = params.get('employee') ?? '';
  const [year, monthNumber] = month.split('-') as [string, string];

  // What is typed in the year box while it is not (yet) a valid year; replaced once the chosen month changes.
  const [yearDraft, setYearDraft] = useState<{ base: string; text: string } | null>(null);
  const yearText = yearDraft?.base === year ? yearDraft.text : year;
  const [filters, setFilters] = useState<MonthlyReportFilters | null>(null);
  const [filtersFailed, setFiltersFailed] = useState(false);
  const [report, setReport] = useState<{ key: string; data: Report | null; failed: boolean }>();

  useEffect(() => {
    monthlyReportApi.filters(area).then(setFilters, () => setFiltersFailed(true));
  }, [area]);

  const key = `${month}|${fieldId}|${employeeId}`;
  useEffect(() => {
    let current = true;
    monthlyReportApi.report(area, { month, fieldId, employeeId }).then(
      (data) => current && setReport({ key, data, failed: false }),
      () => current && setReport({ key, data: null, failed: true }),
    );
    return () => {
      current = false;
    };
  }, [area, key, month, fieldId, employeeId]);

  const update = (changes: Record<string, string>) => {
    const next = { month, field: fieldId, employee: employeeId, ...changes };
    setParams(Object.fromEntries(Object.entries(next).filter(([, value]) => value)), {
      replace: true,
    });
  };

  const yearValid = /^[1-9]\d{3}$/.test(yearText);
  const monthName = (m: number) =>
    new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' }).format(
      Date.UTC(2000, m - 1, 1),
    );
  const monthLabel = new Intl.DateTimeFormat(language, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(Number(year), Number(monthNumber) - 1, 1));
  const shown = report?.key === key ? report : undefined;

  /** Exactly what the table shows, with the month and the filters in use. */
  const exportDocument = (): ExportDocument | null => {
    if (!shown?.data) return null;
    const fieldName = filters?.fields.find((f) => f.id === fieldId)?.name;
    const employeeName = filters?.employees.find((e) => e.id === employeeId)?.fullName;
    return {
      title: t('reports.monthly.title'),
      details: [
        `${t('reports.monthly.month')}: ${monthLabel}`,
        `${t('reports.monthly.field')}: ${fieldName ?? t('reports.monthly.allFields')}`,
        `${t('reports.monthly.employee')}: ${employeeName ?? t('reports.monthly.allEmployees')}`,
      ],
      generated: t('reports.export.generated', { date: new Date().toLocaleString(language) }),
      direction: language === 'ar' ? 'rtl' : 'ltr',
      language,
      fileName: `ims-monthly-report-${month}`,
      sections: [
        {
          columns: [
            { label: t('reports.monthly.trainee'), width: 2 },
            { label: t('reports.monthly.employee'), width: 2 },
            { label: t('reports.monthly.field'), width: 1.5 },
            { label: t('reports.monthly.from') },
            { label: t('reports.monthly.to') },
          ],
          rows: shown.data.rows.map((row) => [
            row.traineeName ?? '—',
            row.employee.fullName,
            row.field.name,
            formatDate(row.startDate, language),
            formatDate(row.endDate, language),
          ]),
          empty: t('reports.monthly.empty'),
        },
      ],
    };
  };

  return (
    <>
      <Link to={backTo} className="ims-btn-text mb-4 inline-flex">
        {t('reports.back')}
      </Link>
      <h1 className="ims-page-title mb-2">{t('reports.monthly.title')}</h1>
      <p className="mb-8 text-muted">{t('reports.monthly.description')}</p>

      <form
        role="search"
        aria-label={t('reports.monthly.filters')}
        className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-month`}>
            {t('reports.monthly.month')}
          </label>
          <select
            id={`${id}-month`}
            className="ims-input"
            value={monthNumber}
            onChange={(e) => update({ month: `${year}-${e.target.value}` })}
          >
            {Array.from({ length: 12 }, (_, i) => {
              const value = String(i + 1).padStart(2, '0');
              return (
                <option key={value} value={value}>
                  {monthName(i + 1)}
                </option>
              );
            })}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-year`}>
            {t('reports.monthly.year')}
          </label>
          <input
            id={`${id}-year`}
            className="ims-input"
            inputMode="numeric"
            maxLength={4}
            value={yearText}
            aria-invalid={!yearValid}
            aria-describedby={yearValid ? undefined : `${id}-year-error`}
            onChange={(e) => {
              const value = e.target.value.trim();
              setYearDraft({ base: year, text: value });
              if (/^[1-9]\d{3}$/.test(value)) update({ month: `${value}-${monthNumber}` });
            }}
          />
          {!yearValid && (
            <p id={`${id}-year-error`} className="ims-error">
              {t('reports.monthly.yearInvalid')}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-field`}>
            {t('reports.monthly.field')}
          </label>
          <select
            id={`${id}-field`}
            className="ims-input"
            value={fieldId}
            onChange={(e) => update({ field: e.target.value })}
          >
            <option value="">{t('reports.monthly.allFields')}</option>
            {filters?.fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-employee`}>
            {t('reports.monthly.employee')}
          </label>
          <select
            id={`${id}-employee`}
            className="ims-input"
            value={employeeId}
            onChange={(e) => update({ employee: e.target.value })}
          >
            <option value="">{t('reports.monthly.allEmployees')}</option>
            {filters?.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName}
              </option>
            ))}
          </select>
        </div>
      </form>

      {filtersFailed && (
        <p role="alert" className="ims-error mb-4">
          {t('reports.monthly.filtersFailed')}
        </p>
      )}

      <section aria-labelledby={`${id}-results`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-results`} className="text-h3 font-semibold text-heading">
            {monthLabel}
          </h2>
          <ExportButtons build={exportDocument} disabled={!shown?.data} />
        </div>
        {!shown ? (
          <p className="ims-state" role="status">
            {t('common.loading')}
          </p>
        ) : shown.failed ? (
          <p className="ims-state" role="alert">
            {t('reports.monthly.loadFailed')}
          </p>
        ) : shown.data!.rows.length === 0 ? (
          <p className="ims-state">{t('reports.monthly.empty')}</p>
        ) : (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('reports.monthly.trainee')}</th>
                  <th scope="col">{t('reports.monthly.employee')}</th>
                  <th scope="col">{t('reports.monthly.field')}</th>
                  <th scope="col">{t('reports.monthly.from')}</th>
                  <th scope="col">{t('reports.monthly.to')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.data!.rows.map((row) => (
                  <tr key={row.assignmentId}>
                    <td className="font-semibold">{row.traineeName ?? '—'}</td>
                    <td>{row.employee.fullName}</td>
                    <td>{row.field.name}</td>
                    <td>{formatDate(row.startDate, language)}</td>
                    <td>{formatDate(row.endDate, language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
