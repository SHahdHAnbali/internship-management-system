import { Outlet } from 'react-router';
import { AreaShell } from '../../components/AreaShell';

/** The Employee area (PDF §4): available trainees, my trainees with their periodic notes, and my reports (§6). */
export function EmployeeArea() {
  return (
    <AreaShell
      tabs={[
        { to: '/employee/available', label: 'employee.nav.available' },
        { to: '/employee/trainees', label: 'employee.nav.trainees' },
        { to: '/employee/reports', label: 'employee.nav.reports' },
      ]}
    >
      <Outlet />
    </AreaShell>
  );
}
