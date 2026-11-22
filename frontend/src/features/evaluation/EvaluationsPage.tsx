import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';
import { evaluationApi } from './evaluationApi';
import type { EvaluationSummary } from './models';

/**
 * Evaluations (R27, stage S2.1; AD-66): the ended trainings (Completed or Ended early) the signed-in Employee or HR user
 * evaluates, as the final mentor or the current responsible HR, with the evaluation status. Read-only. Shown in the
 * Employee and HR areas (`base` is the area's path); the Admin has no such page (AD-68 G2, G4).
 */
export function EvaluationsPage({ base }: { base: string }) {
  const { t, language } = useI18n();
  const [rows, setRows] = useState<EvaluationSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    evaluationApi.list().then(
      (list) => current && setRows(list),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, []);

  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const name = (r: EvaluationSummary) => r.traineeName ?? t('evaluation.traineeUnnamed');

  return (
    <>
      <h1 className="ims-page-title mb-2">{t('evaluation.title')}</h1>
      <p className="mb-8 text-muted">{t('evaluation.intro')}</p>
      {failed ? (
        <p role="alert" className="ims-state">
          {t('training.errors.loadFailed')}
        </p>
      ) : !rows ? null : rows.length === 0 ? (
        <p className="ims-state">{t('evaluation.empty')}</p>
      ) : (
        // `relative`: on a phone this table scrolls inside its card; the card must also clip the sr-only header.
        <div className="ims-table-card relative">
          <table className="ims-table">
            <thead>
              <tr>
                <th scope="col">{t('evaluation.trainee')}</th>
                <th scope="col">{t('training.fields.field')}</th>
                <th scope="col">{t('evaluation.endStatus')}</th>
                <th scope="col">{t('evaluation.endDate')}</th>
                <th scope="col">{t('evaluation.capacity')}</th>
                <th scope="col">{t('evaluation.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('evaluation.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.applicationId}>
                  <td className="font-semibold text-heading">{name(r)}</td>
                  <td>{r.fieldName}</td>
                  <td>{t(`training.assignmentStatus.${r.endStatus}`)}</td>
                  <td>{date(r.endDate)}</td>
                  <td>
                    {r.capacities
                      .map((c) => t(`evaluation.capacities.${c}`))
                      .join(t('evaluation.listSeparator'))}
                  </td>
                  <td>
                    <span className="ims-badge whitespace-nowrap">
                      {t(`evaluation.statuses.${r.status}`)}
                    </span>
                  </td>
                  <td className="text-end">
                    <Link
                      to={`${base}/${r.applicationId}`}
                      className="ims-btn-text"
                      aria-label={`${t('evaluation.open')}: ${name(r)}`}
                    >
                      {t('evaluation.open')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
