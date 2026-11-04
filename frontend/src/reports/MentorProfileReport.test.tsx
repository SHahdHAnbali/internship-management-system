import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../public/i18n/ar.json?raw';
import enMessages from '../../public/i18n/en.json?raw';
import source from './MentorProfileReport.tsx?raw';
import type { SessionUser, UserRole } from '../auth/models';
import { routes } from '../routes';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from '../test/render';
import { MentorProfileReport } from './MentorProfileReport';

afterEach(() => vi.unstubAllGlobals());

const mentor = (id: string, fullName: string, trainees: number, assignments: number) => ({
  employee: { id, fullName },
  trainees,
  assignments,
});
const everyone = [
  mentor('e1', 'Mentor One', 4, 5),
  mentor('e2', 'Mentor Two', 1, 1),
  mentor('e3', 'New Mentor', 0, 0),
];
const mine = mentor('e1', 'Mentor One', 4, 5);

function api(answer: (url: string) => [number, unknown?] | null = () => null) {
  return mockFetch((_method, url) => {
    const custom = answer(url);
    if (custom) return custom;
    if (url === '/api/hr/reports/mentor-profile') return [200, { rows: everyone }];
    if (url === '/api/employee/reports/mentor-profile') return [200, mine];
    return [200, []];
  });
}

const reportCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/mentor-profile'));

function open(scope: 'all' | 'own', i18n = testI18n(null, 'en')) {
  const base = scope === 'all' ? '/hr' : '/employee';
  return renderRoutes(
    [
      {
        path: `${base}/reports/mentor-profile`,
        element: <MentorProfileReport scope={scope} backTo={`${base}/reports`} />,
      },
    ],
    { url: `${base}/reports/mentor-profile`, i18n },
  );
}

describe('MentorProfileReport', () => {
  it('HR: every employee with their trainees and assignments, read-only, nothing else', async () => {
    const fetchMock = api();
    open('all');
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'reports.mentorProfile.employee',
      'reports.mentorProfile.trainees',
      'reports.mentorProfile.assignments',
    ]);
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => [
        within(r).getByRole('rowheader').textContent,
        ...within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ]);
    expect(rows).toEqual([
      ['Mentor One', '4', '5'],
      ['Mentor Two', '1', '1'],
      ['New Mentor', '0', '0'],
    ]);
    expect(reportCalls(fetchMock)).toEqual(['/api/hr/reports/mentor-profile']);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'reports.export.xlsx',
      'reports.export.pdf',
    ]); // only the export buttons: no actions
    // The undefined parts are named as not shown, never as a number.
    expect(screen.getByText('reports.mentorProfile.notShown')).toBeInTheDocument();
    expect(screen.getByText('reports.mentorProfile.countsHint')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'reports.back' })).toHaveAttribute(
      'href',
      '/hr/reports',
    );
  });

  it('Employee: only their own profile, from their own endpoint', async () => {
    const fetchMock = api();
    open('own');
    expect(await screen.findByText('Mentor One')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText('Mentor Two')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(reportCalls(fetchMock)).toEqual(['/api/employee/reports/mentor-profile']); // no id sent
    expect(screen.getByText('reports.mentorProfile.ownDescription')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'reports.back' })).toHaveAttribute(
      'href',
      '/employee/reports',
    );
  });

  it('Employee with no training yet: zeros', async () => {
    api((url) =>
      url.startsWith('/api/employee') ? [200, mentor('e9', 'Fresh Mentor', 0, 0)] : null,
    );
    open('own');
    expect(await screen.findByText('Fresh Mentor')).toBeInTheDocument();
    expect(screen.getAllByText('0')).toHaveLength(2);
  });

  it('HR: says when there are no employees', async () => {
    api((url) => (url.startsWith('/api/hr') ? [200, { rows: [] }] : null));
    open('all');
    expect(await screen.findByText('reports.mentorProfile.empty')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it.each(['all', 'own'] as const)(
    '%s: shows a load error without technical details',
    async (scope) => {
      api(() => [500, { detail: 'Stack trace', code: 'internal' }]);
      open(scope);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'reports.mentorProfile.loadFailed',
      );
      expect(screen.queryByText(/Stack trace|internal|500/)).not.toBeInTheDocument();
    },
  );

  it.each([
    ['ar', arMessages, 'ملف المدرّب', 'المتدربون', 'عمليات الربط', 'لم يُحدَّدا بعد'],
    ['en', enMessages, 'Mentor profile', 'Trainees', 'Training assignments', 'not been defined'],
  ] as const)('reads in %s', async (language, raw, title, trainees, assignments, notShown) => {
    const i18n = testI18n(JSON.parse(raw), language);
    api();
    const first = open('all', i18n);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: trainees })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: assignments })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(notShown))).toBeInTheDocument();
    first.unmount();

    open('own', i18n);
    expect(await screen.findByText(trainees)).toBeInTheDocument();
    expect(screen.getByText(assignments)).toBeInTheDocument();
  });

  it('lays out with logical (RTL/LTR-neutral) classes only', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
  });
});

describe('reaching the mentor profile', () => {
  const signedIn = (role: UserRole): SessionUser => ({
    id: '01a181df-0000-7000-8000-000000000001',
    role,
    email: 'someone@stu.najah.edu',
    name: 'Someone',
  });

  it('HR: Reports → Mentor profile', async () => {
    const fetchMock = api();
    const { router } = renderRoutes(routes, {
      url: '/hr/reports',
      auth: fakeAuth({ user: signedIn('HR') }),
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'reports.mentorProfile.title' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/hr/reports/mentor-profile'));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(reportCalls(fetchMock)).toEqual(['/api/hr/reports/mentor-profile']);
  });

  it('Employee: the My reports tab → Mentor profile, their own', async () => {
    const fetchMock = api();
    const { router } = renderRoutes(routes, {
      url: '/employee/available',
      auth: fakeAuth({ user: signedIn('Employee') }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'employee.nav.reports' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/employee/reports'));
    await user.click(await screen.findByRole('link', { name: 'reports.mentorProfile.title' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/employee/reports/mentor-profile'),
    );
    expect(await screen.findByText('Mentor One')).toBeInTheDocument();
    expect(reportCalls(fetchMock)).toEqual(['/api/employee/reports/mentor-profile']);
  });

  it('Admin: not among the Admin reports (NEW-02)', async () => {
    api();
    renderRoutes(routes, { url: '/admin/reports', auth: fakeAuth({ user: signedIn('Admin') }) });
    expect(await screen.findByRole('link', { name: 'reports.monthly.title' })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'reports.mentorProfile.title' }),
    ).not.toBeInTheDocument();
  });

  it.each(['Admin', 'Trainee', 'Employee', 'HR'] as const)(
    'is not opened for %s outside their own area',
    async (role) => {
      const fetchMock = api();
      const urls = ['/hr/reports/mentor-profile', '/employee/reports/mentor-profile'].filter(
        (url) =>
          !(role === 'HR' && url.startsWith('/hr')) &&
          !(role === 'Employee' && url.startsWith('/employee')),
      );
      for (const url of urls) {
        const { router, unmount } = renderRoutes(routes, {
          url,
          auth: fakeAuth({ user: signedIn(role) }),
        });
        await waitFor(() => expect(router.state.location.pathname).not.toBe(url));
        unmount();
      }
      expect(reportCalls(fetchMock)).toEqual([]);
    },
  );
});
