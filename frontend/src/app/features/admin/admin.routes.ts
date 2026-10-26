import { Routes } from '@angular/router';
import { AdminLayout } from './layout/admin-layout';

/** Admin area (PDF §4): fields, evaluation criteria, users & roles, notification settings. */
export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    component: AdminLayout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'fields' },
      {
        path: 'fields',
        loadComponent: () => import('./fields/fields-page').then((m) => m.FieldsPage),
      },
      {
        path: 'evaluation-criteria',
        loadComponent: () => import('./criteria/criteria-page').then((m) => m.CriteriaPage),
      },
      { path: 'users', loadComponent: () => import('./users/users-page').then((m) => m.UsersPage) },
      {
        path: 'settings',
        loadComponent: () => import('./settings/settings-page').then((m) => m.SettingsPage),
      },
    ],
  },
];
