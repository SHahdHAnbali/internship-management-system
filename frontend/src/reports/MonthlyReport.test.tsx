import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../public/i18n/ar.json?raw';
import enMessages from '../../public/i18n/en.json?raw';
import source from './MonthlyReport.tsx?raw';
import type { SessionUser, UserRole } from '../auth/models';
import { routes } from '../routes';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from '../test/render';
import { MonthlyReport } from './MonthlyReport';

afterEach(() => vi.unstubAllGlobals());

const filters = {
  fields: [
    { id: 'f-qa', name: 'QA' },
    { id: 'f-be', name: 'Backend' },
  ],
  employees: [
    { id: 'e-1', fullName: 'Mentor One' },
    { id: 'e-2', fullName: 'Mentor Two' },
  ],
};

const row = (
  id: string,
  trainee: string,
  employee: [string, string],
  start: string,
  end: string,
) => ({
  assignmentId: id,
  traineeName: trainee,
  employee: { id: employee[0], fullName: employee[1] },
  field: { id: 'f-qa', name: 'QA' },
  startDate: start,
  endDate: end,
});

const february = {
  month: '2031-02',
  monthStart: '2031-02-01',
  monthEnd: '2031-02-28',
  rows: [
    // A trainee moved between employees: two recorded assignments, two rows.
    row('s1', 'Lina Haddad', ['e-1', 'Mentor One'], '2031-01-10', '2031-02-14'),
    row('s2', 'Lina Haddad', ['e-2', 'Mentor Two'], '2031-02-15', '2031-04-30'),
  ],
};

/** A fetch answering the filter choices and the report, recording each report query. */
function api(reportFor: (url: string) => [number, unknown?] = () => [200, february]) {
  return mockFetch((_method, url) =>
    url.includes('/monthly/filters') ? [200, filters] : reportFor(url),
  );
}

const reportCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes('/reports/monthly?'));

function open(
  url = '/hr/reports/monthly?month=2031-02',
  area: 'hr' | 'admin' = 'hr',
  i18n = testI18n(null, 'en'),
) {
  return renderRoutes(
    [
      {
        path: `/${area}/reports/monthly`,
        element: <MonthlyReport area={area} backTo={`/${area}/reports`} />,
      },
      { path: `/${area}/reports`, element: <p>reports list</p> },
    ],
    { url, i18n },
  );
}

describe('MonthlyReport', () => {
  it('shows the month’s trainings read-only with exactly the documented columns', async () => {
    const fetchMock = api();
    open();

    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'reports.monthly.trainee',
      'reports.monthly.employee',
      'reports.monthly.field',
      'reports.monthly.from',
      'reports.monthly.to',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['Lina Haddad', 'Mentor One', 'QA', '1/10/2031', '2/14/2031'],
      ['Lina Haddad', 'Mentor Two', 'QA', '2/15/2031', '4/30/2031'],
    ]);

    expect(reportCalls(fetchMock)).toEqual(['/api/hr/reports/monthly?month=2031-02']);
    expect(fetchMock).toHaveBeenCalledWith('/api/hr/reports/monthly/filters', expect.anything());
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'reports.export.xlsx',
      'reports.export.pdf',
    ]); // only the export buttons: no actions
    expect(screen.getByRole('link', { name: 'reports.back' })).toHaveAttribute(
      'href',
      '/hr/reports',
    );
  });

  it('opens on the current month when none is chosen', async () => {
    const fetchMock = api(() => [200, { ...february, rows: [] }]);
    open('/hr/reports/monthly');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await screen.findByText('reports.monthly.empty');
    expect(reportCalls(fetchMock)).toEqual([`/api/hr/reports/monthly?month=${month}`]);
    expect(screen.getByLabelText('reports.monthly.year')).toHaveValue(String(now.getFullYear()));
  });

  it('asks again for the chosen month, year, field and employee, and keeps them in the address', async () => {
    const fetchMock = api();
    const { router } = open();
    const user = userEvent.setup();
    await screen.findByRole('table');

    // The choices are offered once loaded.
    const field = screen.getByLabelText('reports.monthly.field');
    await waitFor(() =>
      expect(within(field).getByRole('option', { name: 'Backend' })).toBeInTheDocument(),
    );

    await user.selectOptions(screen.getByLabelText('reports.monthly.month'), '03');
    await waitFor(() =>
      expect(reportCalls(fetchMock).at(-1)).toBe('/api/hr/reports/monthly?month=2031-03'),
    );

    const year = screen.getByLabelText('reports.monthly.year');
    await user.clear(year);
    await user.type(year, '203');
    // An incomplete year is flagged and not requested.
    expect(year).toHaveAttribute('aria-invalid', 'true');
    expect(year).toHaveAccessibleDescription('reports.monthly.yearInvalid');
    await user.type(year, '2');
    await waitFor(() =>
      expect(reportCalls(fetchMock).at(-1)).toBe('/api/hr/reports/monthly?month=2032-03'),
    );
    expect(year).toHaveAttribute('aria-invalid', 'false');
    expect(reportCalls(fetchMock).some((url) => url.includes('month=203-'))).toBe(false);

    await user.selectOptions(field, 'f-be');
    await waitFor(() =>
      expect(reportCalls(fetchMock).at(-1)).toBe(
        '/api/hr/reports/monthly?month=2032-03&fieldId=f-be',
      ),
    );
    await user.selectOptions(screen.getByLabelText('reports.monthly.employee'), 'e-2');
    await waitFor(() =>
      expect(reportCalls(fetchMock).at(-1)).toBe(
        '/api/hr/reports/monthly?month=2032-03&fieldId=f-be&employeeId=e-2',
      ),
    );
    expect(router.state.location.search).toBe('?month=2032-03&field=f-be&employee=e-2');

    // Back to all fields.
    await user.selectOptions(field, '');
    await waitFor(() =>
      expect(reportCalls(fetchMock).at(-1)).toBe(
        '/api/hr/reports/monthly?month=2032-03&employeeId=e-2',
      ),
    );
  });

  it('opens with the choices given in the address', async () => {
    const fetchMock = api();
    open('/hr/reports/monthly?month=2031-02&field=f-qa&employee=e-1');
    await screen.findByRole('table');
    expect(reportCalls(fetchMock)).toEqual([
      '/api/hr/reports/monthly?month=2031-02&fieldId=f-qa&employeeId=e-1',
    ]);
    expect(screen.getByLabelText('reports.monthly.month')).toHaveValue('02');
    expect(screen.getByLabelText('reports.monthly.year')).toHaveValue('2031');
    await waitFor(() => expect(screen.getByLabelText('reports.monthly.field')).toHaveValue('f-qa'));
    expect(screen.getByLabelText('reports.monthly.employee')).toHaveValue('e-1');
  });

  it('uses the Admin route in the Admin area', async () => {
    const fetchMock = api();
    open('/admin/reports/monthly?month=2031-02', 'admin');
    await screen.findByRole('table');
    expect(reportCalls(fetchMock)).toEqual(['/api/admin/reports/monthly?month=2031-02']);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/reports/monthly/filters', expect.anything());
    expect(screen.getByRole('link', { name: 'reports.back' })).toHaveAttribute(
      'href',
      '/admin/reports',
    );
  });

  it('says when no one was training that month', async () => {
    api(() => [200, { ...february, rows: [] }]);
    open();
    expect(await screen.findByText('reports.monthly.empty')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a load error without technical details', async () => {
    api(() => [500, { detail: 'Stack trace', code: 'internal' }]);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('reports.monthly.loadFailed');
    expect(screen.queryByText(/Stack trace|internal|500/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('still shows the report when the filter choices cannot be loaded', async () => {
    mockFetch((_method, url) => (url.includes('/filters') ? [500] : [200, february]));
    open();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('reports.monthly.filtersFailed');
  });

  it.each([
    ['ar', arMessages, 'التقرير الشهري', 'المتدرب', 'الموظف', 'كل المجالات', 'فبراير'],
    ['en', enMessages, 'Monthly report', 'Trainee', 'Employee', 'All fields', 'February'],
  ] as const)(
    'reads in %s',
    async (language, raw, title, trainee, employee, allFields, monthName) => {
      api();
      open('/hr/reports/monthly?month=2031-02', 'hr', testI18n(JSON.parse(raw), language));
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      const table = await screen.findByRole('table');
      expect(within(table).getByRole('columnheader', { name: trainee })).toBeInTheDocument();
      expect(within(table).getByRole('columnheader', { name: employee })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: allFields })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(monthName);
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/2031|٢٠٣١/);
    },
  );

  it('lays out with logical (RTL/LTR-neutral) classes only', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
  });
});

describe('reaching the monthly report', () => {
  const signedIn = (role: UserRole): SessionUser => ({
    id: '01a181df-0000-7000-8000-000000000001',
    role,
    email: 'someone@stu.najah.edu',
    name: 'Someone',
  });

  it('HR: Reports → Monthly report', async () => {
    const fetchMock = mockFetch((_method, url) =>
      url.includes('/monthly/filters')
        ? [200, filters]
        : url.includes('/monthly?')
          ? [200, february]
          : [200, []],
    );
    const { router } = renderRoutes(routes, {
      url: '/hr/reports',
      auth: fakeAuth({ user: signedIn('HR') }),
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'reports.monthly.title' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/hr/reports/monthly'));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(reportCalls(fetchMock)[0]).toMatch(/^\/api\/hr\/reports\/monthly\?month=\d{4}-\d{2}$/);
  });

  it('Admin: the Reports page in the Admin navigation → Monthly report', async () => {
    const fetchMock = mockFetch((_method, url) =>
      url.includes('/monthly/filters')
        ? [200, filters]
        : url.includes('/monthly?')
          ? [200, february]
          : [200, []],
    );
    const { router } = renderRoutes(routes, {
      url: '/admin/fields',
      auth: fakeAuth({ user: signedIn('Admin') }),
    });
    const user = userEvent.setup();
    const nav = await screen.findByRole('navigation', { name: 'admin.nav.label' });
    await user.click(within(nav).getAllByRole('link', { name: 'admin.nav.reports' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/reports'));
    await user.click(await screen.findByRole('link', { name: 'reports.monthly.title' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/reports/monthly'));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(reportCalls(fetchMock)[0]).toMatch(
      /^\/api\/admin\/reports\/monthly\?month=\d{4}-\d{2}$/,
    );
  });

  it.each(['Employee', 'Trainee'] as const)('is not opened for %s', async (role) => {
    const fetchMock = mockFetch(() => [200, []]);
    for (const url of ['/hr/reports/monthly', '/admin/reports/monthly']) {
      const { router, unmount } = renderRoutes(routes, {
        url,
        auth: fakeAuth({ user: signedIn(role) }),
      });
      await waitFor(() => expect(router.state.location.pathname).not.toBe(url));
      unmount();
    }
    expect(reportCalls(fetchMock)).toEqual([]);
  });
});
