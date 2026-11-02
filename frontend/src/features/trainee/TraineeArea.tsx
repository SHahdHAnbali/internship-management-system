import { Outlet } from 'react-router';
import { AreaShell } from '../../components/AreaShell';

/** The Trainee area (PDF §4): the status board of their own applications, and the application form. */
export function TraineeArea() {
  return (
    <AreaShell
      tabs={[
        { to: '/trainee', label: 'trainee.nav.applications', end: true },
        { to: '/trainee/apply', label: 'trainee.nav.apply' },
      ]}
    >
      <Outlet />
    </AreaShell>
  );
}
