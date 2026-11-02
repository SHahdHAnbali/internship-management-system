import { Outlet } from 'react-router';
import { AreaShell } from '../../components/AreaShell';

/** The Employee area (PDF §4): available trainees, and my trainees with their periodic notes. */
export function EmployeeArea() {
  return (
    <AreaShell
      tabs={[
        { to: '/employee/available', label: 'employee.nav.available' },
        { to: '/employee/trainees', label: 'employee.nav.trainees' },
      ]}
    >
      <Outlet />
    </AreaShell>
  );
}
