import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/context';
import { ExportButtons } from './export/ExportButtons';
import { fileDate } from './export/files';
import type { ExportDocument } from './export/model';
import { mentorProfileApi, type MentorProfile } from './mentorProfileApi';

/**
 * The mentor profile (PDF §6 «ملف المدرّب», for HR and each employee for themself), as far as it is defined: how many
 * trainees each employee has had and how many assignment records, over every stored status. HR sees every employee;
 * an employee only their own profile. The average evaluation and the breakdown over time are not shown: neither is
 * defined yet, and the page says so instead of showing a number.
 */
export function MentorProfileReport({ scope, backTo }: { scope: 'all' | 'own'; backTo: string }) {
  const { t, language } = useI18n();
  const [state, setState] = useState<{ rows: MentorProfile[] | null; failed: boolean }>();

  useEffect(() => {
    const load =
      scope === 'all'
        ? mentorProfileApi.all().then((r) => r.rows)
        : mentorProfileApi.own().then((own) => [own]);
    load.then(
      (rows) => setState({ rows, failed: false }),
      () => setState({ rows: null, failed: true }),
    );
  }, [scope]);

  /** Exactly what the page shows: every employee (HR) or the employee's own row, with the page's notes. */
  const exportDocument = (): ExportDocument | null => {
    if (!state?.rows) return null;
    return {
      title: t('reports.mentorProfile.title'),
      details: [t('reports.mentorProfile.countsHint'), t('reports.mentorProfile.notShown')],
      generated: t('reports.export.generated', { date: new Date().toLocaleString(language) }),
      direction: language === 'ar' ? 'rtl' : 'ltr',
      language,
      fileName: `ims-${scope === 'own' ? 'my-' : ''}mentor-profile-${fileDate()}`,
      sections: [
        {
          columns: [
            { label: t('reports.mentorProfile.employee'), width: 3 },
            { label: t('reports.mentorProfile.trainees'), numeric: true },
            { label: t('reports.mentorProfile.assignments'), numeric: true },
          ],
          rows: state.rows.map((row) => [row.employee.fullName, row.trainees, row.assignments]),
          empty: t('reports.mentorProfile.empty'),
        },
      ],
    };
  };

  return (
    <>
      <Link to={backTo} className="ims-btn-text mb-4 inline-flex">
        {t('reports.back')}
      </Link>
      <h1 className="ims-page-title mb-2">{t('reports.mentorProfile.title')}</h1>
      <p className="mb-8 text-muted">
        {t(
          scope === 'all'
            ? 'reports.mentorProfile.description'
            : 'reports.mentorProfile.ownDescription',
        )}
      </p>

      <div className="mb-4 flex justify-end">
        <ExportButtons build={exportDocument} disabled={!state?.rows} />
      </div>

      {!state ? (
        <p className="ims-state" role="status">
          {t('common.loading')}
        </p>
      ) : state.failed ? (
        <p className="ims-state" role="alert">
          {t('reports.mentorProfile.loadFailed')}
        </p>
      ) : scope === 'own' ? (
        <dl className="ims-card grid max-w-md gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-small text-muted">{t('reports.mentorProfile.employee')}</dt>
            <dd className="text-h3 font-semibold text-heading">
              {state.rows![0]!.employee.fullName}
            </dd>
          </div>
          <div>
            <dt className="text-small text-muted">{t('reports.mentorProfile.trainees')}</dt>
            <dd className="text-h3 font-semibold text-heading">{state.rows![0]!.trainees}</dd>
          </div>
          <div>
            <dt className="text-small text-muted">{t('reports.mentorProfile.assignments')}</dt>
            <dd className="text-h3 font-semibold text-heading">{state.rows![0]!.assignments}</dd>
          </div>
        </dl>
      ) : state.rows!.length === 0 ? (
        <p className="ims-state">{t('reports.mentorProfile.empty')}</p>
      ) : (
        <div className="ims-table-card">
          <table className="ims-table">
            <thead>
              <tr>
                <th scope="col">{t('reports.mentorProfile.employee')}</th>
                <th scope="col">{t('reports.mentorProfile.trainees')}</th>
                <th scope="col">{t('reports.mentorProfile.assignments')}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows!.map((row) => (
                <tr key={row.employee.id}>
                  <th scope="row" className="font-semibold text-heading">
                    {row.employee.fullName}
                  </th>
                  <td>{row.trainees}</td>
                  <td>{row.assignments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-small text-muted">{t('reports.mentorProfile.countsHint')}</p>
      <p className="mt-1 text-small text-muted">{t('reports.mentorProfile.notShown')}</p>
    </>
  );
}
