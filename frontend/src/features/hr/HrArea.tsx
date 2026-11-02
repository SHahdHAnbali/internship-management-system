import { Outlet } from 'react-router';
import { AreaShell } from '../../components/AreaShell';

/**
 * The HR area, so far: training applications (review, accept, reject), employees' mentor requests, the trainings
 * (read-only) and the reports, so far the trainee history (PDF §4, §6).
 */
export function HrArea() {
  return (
    <AreaShell
      tabs={[
        { to: '/hr/applications', label: 'hr.nav.applications' },
        { to: '/hr/mentor-requests', label: 'hr.nav.mentorRequests' },
        { to: '/hr/trainings', label: 'hr.nav.trainings' },
        { to: '/hr/reports', label: 'hr.nav.reports' },
      ]}
    >
      <Outlet />
    </AreaShell>
  );
}
