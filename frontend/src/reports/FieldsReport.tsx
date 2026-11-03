import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useI18n } from '../i18n/context';
import { fieldsReportApi, type FieldsReport as Report } from './fieldsReportApi';
import type { ReportArea } from './monthlyReportApi';

/**
 * The fields report (PDF §6 «تقرير المجالات», for HR and the Admin), as far as it is defined: for every field, the number
 * of applications and of accepted applications. The "completed" count is not shown, because when a training counts as
 * completed has not been decided; the page says so instead of showing a number. Filterable by field; the choice is kept
 * in the address.
 */
export function FieldsReport({ area, backTo }: { area: ReportArea; backTo: string }) {
  const { t } = useI18n();
  const id = useId();
  const [params, setParams] = useSearchParams();
  const fieldId = params.get('field') ?? '';

  // Every field (also the filter's choices), then the chosen field's row when one is chosen.
  const [all, setAll] = useState<{ data: Report | null; failed: boolean }>();
  const [one, setOne] = useState<{ fieldId: string; data: Report | null; failed: boolean }>();

  useEffect(() => {
    fieldsReportApi.report(area).then(
      (data) => setAll({ data, failed: false }),
      () => setAll({ data: null, failed: true }),
    );
  }, [area]);

  useEffect(() => {
    if (!fieldId) return;
    let current = true;
    fieldsReportApi.report(area, fieldId).then(
      (data) => current && setOne({ fieldId, data, failed: false }),
      () => current && setOne({ fieldId, data: null, failed: true }),
    );
    return () => {
      current = false;
    };
  }, [area, fieldId]);

  const shown = fieldId ? (one?.fieldId === fieldId ? one : undefined) : all;

  return (
    <>
      <Link to={backTo} className="ims-btn-text mb-4 inline-flex">
        {t('reports.back')}
      </Link>
      <h1 className="ims-page-title mb-2">{t('reports.fields.title')}</h1>
      <p className="mb-8 text-muted">{t('reports.fields.description')}</p>

      <form
        role="search"
        aria-label={t('reports.fields.filters')}
        className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-field`}>
            {t('reports.fields.field')}
          </label>
          <select
            id={`${id}-field`}
            className="ims-input"
            value={fieldId}
            onChange={(e) =>
              setParams(e.target.value ? { field: e.target.value } : {}, { replace: true })
            }
          >
            <option value="">{t('reports.fields.allFields')}</option>
            {all?.data?.rows.map((row) => (
              <option key={row.field.id} value={row.field.id}>
                {row.field.name}
              </option>
            ))}
          </select>
        </div>
      </form>

      {!shown ? (
        <p className="ims-state" role="status">
          {t('common.loading')}
        </p>
      ) : shown.failed ? (
        <p className="ims-state" role="alert">
          {t('reports.fields.loadFailed')}
        </p>
      ) : shown.data!.rows.length === 0 ? (
        <p className="ims-state">
          {t(fieldId ? 'reports.fields.noMatch' : 'reports.fields.empty')}
        </p>
      ) : (
        <div className="ims-table-card">
          <table className="ims-table">
            <thead>
              <tr>
                <th scope="col">{t('reports.fields.field')}</th>
                <th scope="col">{t('reports.fields.applications')}</th>
                <th scope="col">{t('reports.fields.accepted')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.data!.rows.map((row) => (
                <tr key={row.field.id}>
                  <th scope="row" className="font-semibold text-heading">
                    {row.field.name}
                  </th>
                  <td>{row.applications}</td>
                  <td>{row.accepted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-small text-muted">{t('reports.fields.completedNotShown')}</p>
    </>
  );
}
