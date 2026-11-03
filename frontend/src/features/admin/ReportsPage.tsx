import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';

/**
 * Admin: the reports the PDF gives the Admin (§6). So far the monthly report; the fields report and the period /
 * field / employee filters and Excel / PDF export of the other reports are not built.
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
      </ul>
    </>
  );
}
