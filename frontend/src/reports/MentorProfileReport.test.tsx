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
    const chosen = /^\/api\/hr\/reports\/mentor-profile\?employeeId=(.+)$/.exec(url);
    if (chosen) return [200, { rows: everyone.filter((r) => r.employee.id === chosen[1]) }];
    if (url === '/api/employee/reports/mentor-profile') return [200, mine];
    return [200, []];
  });
}

const reportCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/mentor-profile'));

function open(scope: 'all' | 'own', i18n = testI18n(null, 'en'), query = '') {
  const base = scope === 'all' ? '/hr' : '/employee';
  return renderRoutes(
    [
      {
        path: `${base}/reports/mentor-profile`,
        element: <MentorProfileReport scope={scope} backTo={`${base}/reports`} />,
      },
    ],
    { url: `${base}/reports/mentor-profile${query}`, i18n },
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
    [
      'ar',
      arMessages,
      'ملف المدرّب',
      'المتدربون',
      'عمليات الربط',
      'لم يُحدَّدا بعد',
      'الموظف',
      'كل الموظفين',
    ],
    [
      'en',
      enMessages,
      'Mentor profile',
      'Trainees',
      'Training assignments',
      'not been defined',
      'Employee',
      'All employees',
    ],
  ] as const)(
    'reads in %s',
    async (language, raw, title, trainees, assignments, notShown, employee, all) => {
      const i18n = testI18n(JSON.parse(raw), language);
      api();
      const first = open('all', i18n);
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      const table = await screen.findByRole('table');
      expect(within(table).getByRole('columnheader', { name: trainees })).toBeInTheDocument();
      expect(within(table).getByRole('columnheader', { name: assignments })).toBeInTheDocument();
      expect(screen.getByText(new RegExp(notShown))).toBeInTheDocument();
      const selector = screen.getByRole('combobox', { name: employee });
      expect(within(selector).getAllByRole('option')[0]).toHaveTextContent(all);
      first.unmount();

      open('own', i18n);
      expect(await screen.findByText(trainees)).toBeInTheDocument();
      expect(screen.getByText(assignments)).toBeInTheDocument();
    },
  );

  describe('HR employee filter (PDF §6)', () => {
    const shownRows = () =>
      within(screen.getByRole('table'))
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r).getByRole('rowheader').textContent);
    const selector = () => screen.getByRole('combobox', { name: 'reports.mentorProfile.employee' });
    const optionTexts = () =>
      within(selector())
        .getAllByRole('option')
        .map((o) => o.textContent);

    it('starts at All employees, offering the employees of the report', async () => {
      const fetchMock = api();
      open('all');
      await screen.findByRole('table');
      expect(
        screen.getByRole('search', { name: 'reports.mentorProfile.filters' }),
      ).toBeInTheDocument();
      expect(selector()).toHaveValue('');
      expect(optionTexts()).toEqual([
        'reports.mentorProfile.allEmployees',
        'Mentor One',
        'Mentor Two',
        'New Mentor',
      ]);
      expect(shownRows()).toEqual(['Mentor One', 'Mentor Two', 'New Mentor']);
      expect(reportCalls(fetchMock)).toEqual(['/api/hr/reports/mentor-profile']); // one request
    });

    it('shows only the chosen employee, from the API; clearing it shows everyone again without a request', async () => {
      const fetchMock = api();
      const { router } = open('all');
      await screen.findByRole('table');
      const user = userEvent.setup();

      await user.selectOptions(selector(), 'e2');
      await waitFor(() => expect(shownRows()).toEqual(['Mentor Two']));
      const cells = within(screen.getByRole('table'))
        .getAllByRole('cell')
        .map((c) => c.textContent);
      expect(cells).toEqual(['1', '1']); // the same counts as in the full list
      expect(router.state.location.search).toBe('?employee=e2');
      expect(reportCalls(fetchMock)).toEqual([
        '/api/hr/reports/mentor-profile',
        '/api/hr/reports/mentor-profile?employeeId=e2',
      ]);

      await user.selectOptions(selector(), '');
      await waitFor(() => expect(shownRows()).toEqual(['Mentor One', 'Mentor Two', 'New Mentor']));
      expect(router.state.location.search).toBe('');
      expect(reportCalls(fetchMock)).toHaveLength(2); // nothing fetched to show everyone again
    });

    it('opens on the employee kept in the address', async () => {
      const fetchMock = api();
      open('all', undefined, '?employee=e3');
      await waitFor(() => expect(shownRows()).toEqual(['New Mentor']));
      expect(selector()).toHaveValue('e3');
      expect(reportCalls(fetchMock)).toContain('/api/hr/reports/mentor-profile?employeeId=e3');
    });

    it('says so when no row matches (an employee not in the list)', async () => {
      api();
      open('all', undefined, '?employee=e404');
      expect(await screen.findByText('reports.mentorProfile.noMatch')).toBeInTheDocument();
      expect(screen.queryByText('reports.mentorProfile.empty')).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(selector()).toHaveValue('e404');
      await waitFor(() => expect(optionTexts().at(-1)).toBe('—')); // not shown as All employees
    });

    it('no row for an employee chosen from the list: no matching employees; a match shows the table', async () => {
      api((url) => (url.endsWith('employeeId=e2') ? [200, { rows: [] }] : null));
      open('all');
      await screen.findByRole('table');
      const user = userEvent.setup();
      await user.selectOptions(selector(), 'e2');
      expect(await screen.findByText('reports.mentorProfile.noMatch')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      await user.selectOptions(selector(), 'e1');
      await waitFor(() => expect(shownRows()).toEqual(['Mentor One']));
      expect(screen.queryByText('reports.mentorProfile.noMatch')).not.toBeInTheDocument();
    });

    it.each([
      ['ar', arMessages, 'لا يوجد موظفون بعد.', 'لا يوجد موظفون مطابقون.'],
      ['en', enMessages, 'No employees yet.', 'No matching employees.'],
    ] as const)(
      'empty messages in %s: none at all, and none matching',
      async (language, raw, none, noMatch) => {
        const i18n = testI18n(JSON.parse(raw), language);
        api((url) => (url === '/api/hr/reports/mentor-profile' ? [200, { rows: [] }] : null));
        const first = open('all', i18n);
        expect(await screen.findByText(none)).toBeInTheDocument();
        expect(screen.queryByText(noMatch)).not.toBeInTheDocument();
        first.unmount();

        api();
        open('all', i18n, '?employee=e404');
        expect(await screen.findByText(noMatch)).toBeInTheDocument();
        expect(screen.queryByText(none)).not.toBeInTheDocument();
      },
    );

    it('shows the load error for a failed filtered request, without technical details', async () => {
      api((url) => (url.includes('employeeId=') ? [500, { detail: 'Stack trace' }] : null));
      open('all');
      await screen.findByRole('table');
      await userEvent.setup().selectOptions(selector(), 'e1');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'reports.mentorProfile.loadFailed',
      );
      expect(screen.queryByText(/Stack trace/)).not.toBeInTheDocument();
    });

    it('shows loading while the chosen employee loads, never the previous rows', async () => {
      let release: (value: Response) => void = () => undefined;
      const base = api();
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      base.mockImplementation((url: string) =>
        url.includes('employeeId=')
          ? new Promise<Response>((resolve) => (release = resolve))
          : Promise.resolve(json({ rows: everyone })),
      );
      open('all');
      await screen.findByRole('table');
      await userEvent.setup().selectOptions(selector(), 'e2');
      expect(await screen.findByRole('status')).toHaveTextContent('common.loading');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'reports.export.xlsx' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ); // no export of rows that are not shown
      release(json({ rows: [everyone[1]] }));
      await waitFor(() => expect(shownRows()).toEqual(['Mentor Two']));
    });

    it('is not offered on an employee’s own profile', async () => {
      api();
      open('own', undefined, '?employee=e2');
      expect(await screen.findByText('Mentor One')).toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });
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
