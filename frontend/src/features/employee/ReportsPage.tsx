import { Link } from 'react-router';
import { useI18n } from '../../i18n/context';

/** Employee: their own reports (PDF §2 matrix «تقاريره فقط»; §6 the mentor profile "for the employee themself"). */
export function ReportsPage() {
  const { t } = useI18n();
  return (
    <>
      <h1 className="ims-page-title mb-8">{t('employee.reports.title')}</h1>
      <ul className="grid gap-4 sm:grid-cols-2">
        <li className="ims-card">
          <h2 className="mb-1 text-h3 font-semibold text-heading">
            <Link to="/employee/reports/mentor-profile">{t('reports.mentorProfile.title')}</Link>
          </h2>
          <p className="text-muted">{t('reports.mentorProfile.ownDescription')}</p>
        </li>
      </ul>
    </>
  );
}
