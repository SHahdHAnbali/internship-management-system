import { Routes } from '@angular/router';

/**
 * One lazy-loaded area per role, plus the public certificate page.
 * Role guards are attached here when authentication is implemented.
 */
export const routes: Routes = [
  {
    path: 'c',
    loadChildren: () => import('./features/public/public.routes').then((m) => m.PUBLIC_ROUTES),
  },
  {
    path: 'trainee',
    loadChildren: () => import('./features/trainee/trainee.routes').then((m) => m.TRAINEE_ROUTES),
  },
  {
    path: 'employee',
    loadChildren: () => import('./features/employee/employee.routes').then((m) => m.EMPLOYEE_ROUTES),
  },
  {
    path: 'hr',
    loadChildren: () => import('./features/hr/hr.routes').then((m) => m.HR_ROUTES),
  },
  {
    path: 'admin',
    loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
  },
];
