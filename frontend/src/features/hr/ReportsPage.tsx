import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';

/**
 * HR: the reports (PDF §6 «السجلات والتقارير»). Built so far: the monthly report (with its field and employee filters)
 * and the trainee history. The other reports, the trainee history's filters and Excel / PDF export are not.
 */
export function ReportsPage() {
  const { t } = useI18n();
  return (
    <>
      <h1 className="ims-page-title mb-8">{t('hr.reports.title')}</h1>
      <ul className="grid gap-4 sm:grid-cols-2">
        <li className="ims-card">
          <h2 className="mb-1 text-h3 font-semibold text-heading">
            <Link to="/hr/reports/monthly">{t('reports.monthly.title')}</Link>
          </h2>
          <p className="text-muted">{t('reports.monthly.description')}</p>
        </li>
        <li className="ims-card">
          <h2 className="mb-1 text-h3 font-semibold text-heading">
            <Link to="/hr/reports/trainee-history">{t('hr.reports.traineeHistory.title')}</Link>
          </h2>
          <p className="text-muted">{t('hr.reports.traineeHistory.description')}</p>
        </li>
      </ul>
    </>
  );
}
