import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';

/**
 * Admin: the reports the PDF gives the Admin (§6): the monthly report and the fields report (without its "completed"
 * count, which is not decided). Excel / PDF export is not built.
 */
export function ReportsPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t('admin.reports.title')} />
      <ul className="grid gap-4 sm:grid-cols-2">
        <li className="ims-card">
          <h2 className="mb-1 text-h3 font-semibold text-heading">
            <Link to="/admin/reports/monthly">{t('reports.monthly.title')}</Link>
          </h2>
          <p className="text-muted">{t('reports.monthly.description')}</p>
        </li>
        <li className="ims-card">
          <h2 className="mb-1 text-h3 font-semibold text-heading">
            <Link to="/admin/reports/fields">{t('reports.fields.title')}</Link>
          </h2>
          <p className="text-muted">{t('reports.fields.description')}</p>
        </li>
      </ul>
    </>
  );
}
