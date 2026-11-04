import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../public/i18n/ar.json?raw';
import enMessages from '../../public/i18n/en.json?raw';
import source from './FieldsReport.tsx?raw';
import type { SessionUser, UserRole } from '../auth/models';
import { routes } from '../routes';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from '../test/render';
import { FieldsReport } from './FieldsReport';

afterEach(() => vi.unstubAllGlobals());

const rows = [
  { field: { id: 'f-be', name: 'Backend' }, applications: 5, accepted: 2 },
  { field: { id: 'f-qa', name: 'QA' }, applications: 1, accepted: 0 },
  { field: { id: 'f-ux', name: 'UX' }, applications: 0, accepted: 0 },
];

/** The API: all fields, or only the requested one. */
function api(answer: (url: string) => [number, unknown?] | null = () => null) {
  return mockFetch((_method, url) => {
    const custom = answer(url);
    if (custom) return custom;
    const fieldId = new URLSearchParams(url.split('?')[1] ?? '').get('fieldId');
    return [200, { rows: fieldId ? rows.filter((r) => r.field.id === fieldId) : rows }];
  });
}

const reportCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/reports/fields'));

function open(
  url = '/hr/reports/fields',
  area: 'hr' | 'admin' = 'hr',
  i18n = testI18n(null, 'en'),
) {
  return renderRoutes(
    [
      {
        path: `/${area}/reports/fields`,
        element: <FieldsReport area={area} backTo={`/${area}/reports`} />,
      },
    ],
    { url, i18n },
  );
}

const tableRows = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => [
      within(r).getByRole('rowheader').textContent,
      ...within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ]);

describe('FieldsReport', () => {
  it('lists every field with its applications and accepted applications, and no completed count', async () => {
    const fetchMock = api();
    open();
    await screen.findByRole('table');
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['reports.fields.field', 'reports.fields.applications', 'reports.fields.accepted']);
    expect(tableRows()).toEqual([
      ['Backend', '5', '2'],
      ['QA', '1', '0'],
      ['UX', '0', '0'], // a field without applications is listed
    ]);
    // The completed count is not presented as a number; the page says it is not shown yet.
    expect(screen.getByText('reports.fields.completedNotShown')).toBeInTheDocument();
    expect(screen.queryByText(/complet/i, { selector: 'th' })).not.toBeInTheDocument();
    expect(reportCalls(fetchMock)).toEqual(['/api/hr/reports/fields']);
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

  it('filters by field through the API, keeps the choice in the address, and back to all', async () => {
    const fetchMock = api();
    const { router } = open();
    const user = userEvent.setup();
    await screen.findByRole('table');

    const field = screen.getByLabelText('reports.fields.field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['reports.fields.allFields', 'Backend', 'QA', 'UX']);
    await user.selectOptions(field, 'f-qa');
    await waitFor(() => expect(tableRows()).toEqual([['QA', '1', '0']]));
    expect(reportCalls(fetchMock).at(-1)).toBe('/api/hr/reports/fields?fieldId=f-qa');
    expect(router.state.location.search).toBe('?field=f-qa');

    await user.selectOptions(field, '');
    await waitFor(() => expect(tableRows()).toHaveLength(3));
    expect(router.state.location.search).toBe('');
  });

  it('opens with a field given in the address', async () => {
    const fetchMock = api();
    open('/hr/reports/fields?field=f-be');
    await waitFor(() => expect(tableRows()).toEqual([['Backend', '5', '2']]));
    expect(reportCalls(fetchMock)).toContain('/api/hr/reports/fields?fieldId=f-be');
    await waitFor(() => expect(screen.getByLabelText('reports.fields.field')).toHaveValue('f-be'));
  });

  it('uses the Admin route in the Admin area', async () => {
    const fetchMock = api();
    open('/admin/reports/fields', 'admin');
    await screen.findByRole('table');
    expect(reportCalls(fetchMock)).toEqual(['/api/admin/reports/fields']);
    expect(screen.getByRole('link', { name: 'reports.back' })).toHaveAttribute(
      'href',
      '/admin/reports',
    );
  });

  it('says when there are no fields, or the chosen one is not in the report', async () => {
    api(() => [200, { rows: [] }]);
    const first = open();
    expect(await screen.findByText('reports.fields.empty')).toBeInTheDocument();
    first.unmount();

    api((url) => (url.includes('fieldId') ? [200, { rows: [] }] : null));
    open('/hr/reports/fields?field=unknown');
    expect(await screen.findByText('reports.fields.noMatch')).toBeInTheDocument();
  });

  it('shows a load error without technical details', async () => {
    api(() => [500, { detail: 'Stack trace', code: 'internal' }]);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('reports.fields.loadFailed');
    expect(screen.queryByText(/Stack trace|internal|500/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'تقرير المجالات', 'الطلبات', 'المقبولون', 'لم يُحدَّد بعد'],
    ['en', enMessages, 'Fields report', 'Applications', 'Accepted', 'has not been decided'],
  ] as const)('reads in %s', async (language, raw, title, applications, accepted, note) => {
    api();
    open('/hr/reports/fields', 'hr', testI18n(JSON.parse(raw), language));
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: applications })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: accepted })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(note))).toBeInTheDocument();
  });

  it('lays out with logical (RTL/LTR-neutral) classes only', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
  });
});

describe('reaching the fields report', () => {
  const signedIn = (role: UserRole): SessionUser => ({
    id: '01a181df-0000-7000-8000-000000000001',
    role,
    email: 'someone@stu.najah.edu',
    name: 'Someone',
  });
  const answer = (url: string): [number, unknown] =>
    url.includes('/reports/fields') ? [200, { rows }] : [200, []];

  it.each([
    ['HR', '/hr/reports', '/api/hr/reports/fields'],
    ['Admin', '/admin/reports', '/api/admin/reports/fields'],
  ] as const)('%s: Reports → Fields report', async (role, reports, endpoint) => {
    const fetchMock = mockFetch((_m, url) => answer(url));
    const { router } = renderRoutes(routes, {
      url: reports,
      auth: fakeAuth({ user: signedIn(role) }),
    });
    await userEvent
      .setup()
      .click(await screen.findByRole('link', { name: 'reports.fields.title' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`${reports}/fields`));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(reportCalls(fetchMock)).toEqual([endpoint]);
  });

  it.each(['Employee', 'Trainee'] as const)('is not opened for %s', async (role) => {
    const fetchMock = mockFetch(() => [200, []]);
    for (const url of ['/hr/reports/fields', '/admin/reports/fields']) {
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
