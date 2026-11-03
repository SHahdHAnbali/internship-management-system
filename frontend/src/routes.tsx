import { Navigate, type RouteObject } from 'react-router';
import { RequireRole, RequireSignedOut } from './auth/guards';
import { HomePage } from './features/public/HomePage';

/**
 * Routes: public pages, sign-in, and one guarded area per role (the API enforces the same permissions on every request).
 * Everything except the homepage is code-split with route-level `lazy`.
 */
export const routes: RouteObject[] = [
  {
    // Public pages for signed-out visitors. A signed-in user (valid session) goes straight to their own area; nothing
    // is shown while the session is being checked, so the homepage does not flash before the redirect.
    element: <RequireSignedOut />,
    children: [
      { path: '/', element: <HomePage /> },
      {
        path: '/sign-in',
        lazy: () =>
          import('./features/public/SignInPage').then((m) => ({ Component: m.SignInPage })),
      },
    ],
  },
  {
    path: '/sign-in/verify',
    lazy: () =>
      import('./features/public/VerifyLinkPage').then((m) => ({ Component: m.VerifyLinkPage })),
  },
  {
    // Trainee (PDF §4): the status board of their own applications, and the application form.
    path: '/trainee',
    element: <RequireRole role="Trainee" />,
    children: [
      {
        lazy: () =>
          import('./features/trainee/TraineeArea').then((m) => ({ Component: m.TraineeArea })),
        children: [
          {
            index: true,
            lazy: () =>
              import('./features/trainee/TraineeHome').then((m) => ({ Component: m.TraineeHome })),
          },
          {
            path: 'apply',
            lazy: () =>
              import('./features/trainee/ApplyPage').then((m) => ({ Component: m.ApplyPage })),
          },
        ],
      },
    ],
  },
  {
    // Employee (PDF §4): available trainees, and my trainees with periodic notes.
    path: '/employee',
    element: <RequireRole role="Employee" />,
    children: [
      {
        lazy: () =>
          import('./features/employee/EmployeeArea').then((m) => ({ Component: m.EmployeeArea })),
        children: [
          { index: true, element: <Navigate to="available" replace /> },
          {
            path: 'available',
            lazy: () =>
              import('./features/employee/AvailableTraineesPage').then((m) => ({
                Component: m.AvailableTraineesPage,
              })),
          },
          {
            path: 'trainees',
            lazy: () =>
              import('./features/employee/MyTraineesPage').then((m) => ({
                Component: m.MyTraineesPage,
              })),
          },
          {
            path: 'reports',
            lazy: () =>
              import('./features/employee/ReportsPage').then((m) => ({
                Component: m.ReportsPage,
              })),
          },
          {
            path: 'reports/mentor-profile',
            lazy: () =>
              import('./reports/MentorProfileReport').then((m) => ({
                Component: () => <m.MentorProfileReport scope="own" backTo="/employee/reports" />,
              })),
          },
        ],
      },
    ],
  },
  {
    // HR (PDF §4), so far: applications and mentor requests.
    path: '/hr',
    element: <RequireRole role="HR" />,
    children: [
      {
        lazy: () => import('./features/hr/HrArea').then((m) => ({ Component: m.HrArea })),
        children: [
          { index: true, element: <Navigate to="applications" replace /> },
          {
            path: 'applications',
            lazy: () =>
              import('./features/hr/ApplicationsPage').then((m) => ({
                Component: m.ApplicationsPage,
              })),
          },
          {
            path: 'applications/:id',
            lazy: () =>
              import('./features/hr/ApplicationDetailPage').then((m) => ({
                Component: m.ApplicationDetailPage,
              })),
          },
          {
            path: 'mentor-requests',
            lazy: () =>
              import('./features/hr/MentorRequestsPage').then((m) => ({
                Component: m.MentorRequestsPage,
              })),
          },
          {
            path: 'trainings',
            lazy: () =>
              import('./features/hr/TrainingsPage').then((m) => ({
                Component: m.TrainingsPage,
              })),
          },
          {
            path: 'reports',
            lazy: () =>
              import('./features/hr/ReportsPage').then((m) => ({
                Component: m.ReportsPage,
              })),
          },
          {
            path: 'reports/monthly',
            lazy: () =>
              import('./reports/MonthlyReport').then((m) => ({
                Component: () => <m.MonthlyReport area="hr" backTo="/hr/reports" />,
              })),
          },
          {
            path: 'reports/fields',
            lazy: () =>
              import('./reports/FieldsReport').then((m) => ({
                Component: () => <m.FieldsReport area="hr" backTo="/hr/reports" />,
              })),
          },
          {
            path: 'reports/mentor-profile',
            lazy: () =>
              import('./reports/MentorProfileReport').then((m) => ({
                Component: () => <m.MentorProfileReport scope="all" backTo="/hr/reports" />,
              })),
          },
          {
            path: 'reports/trainee-history',
            lazy: () =>
              import('./features/hr/TraineeHistoryReport').then((m) => ({
                Component: m.TraineeHistoryReport,
              })),
          },
        ],
      },
    ],
  },
  {
    // Ordinary Google users (no role): their own account only.
    path: '/account',
    element: <RequireRole role={null} />,
    children: [
      {
        index: true,
        lazy: () =>
          import('./features/areas/AreaHome').then((m) => ({
            Component: () => <m.AreaHome area="account" />,
          })),
      },
    ],
  },
  {
    path: '/admin',
    element: <RequireRole role="Admin" />,
    children: [
      {
        lazy: () =>
          import('./features/admin/AdminLayout').then((m) => ({ Component: m.AdminLayout })),
        children: [
          { index: true, element: <Navigate to="fields" replace /> },
          {
            path: 'fields',
            lazy: () =>
              import('./features/admin/FieldsPage').then((m) => ({ Component: m.FieldsPage })),
          },
          {
            path: 'evaluation-criteria',
            lazy: () =>
              import('./features/admin/CriteriaPage').then((m) => ({ Component: m.CriteriaPage })),
          },
          {
            path: 'users',
            lazy: () =>
              import('./features/admin/UsersPage').then((m) => ({ Component: m.UsersPage })),
          },
          {
            path: 'accepted-trainees',
            lazy: () =>
              import('./features/admin/AcceptedTraineesPage').then((m) => ({
                Component: m.AcceptedTraineesPage,
              })),
          },
          {
            path: 'reports',
            lazy: () =>
              import('./features/admin/ReportsPage').then((m) => ({ Component: m.ReportsPage })),
          },
          {
            path: 'reports/monthly',
            lazy: () =>
              import('./reports/MonthlyReport').then((m) => ({
                Component: () => <m.MonthlyReport area="admin" backTo="/admin/reports" />,
              })),
          },
          {
            path: 'reports/fields',
            lazy: () =>
              import('./reports/FieldsReport').then((m) => ({
                Component: () => <m.FieldsReport area="admin" backTo="/admin/reports" />,
              })),
          },
          {
            path: 'settings',
            lazy: () =>
              import('./features/admin/SettingsPage').then((m) => ({ Component: m.SettingsPage })),
          },
          {
            path: 'certificate',
            lazy: () =>
              import('./features/admin/certificate/CertificateTemplatePage').then((m) => ({
                Component: m.CertificateTemplatePage,
              })),
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];
