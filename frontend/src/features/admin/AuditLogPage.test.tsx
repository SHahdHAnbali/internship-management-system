import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import source from './AuditLogPage.tsx?raw';
import type { SessionUser, UserRole } from '../../auth/models';
import { routes } from '../../routes';
import { fakeAuth, mockFetch, renderPage, renderRoutes, testI18n } from '../../test/render';
import { AuditLogPage } from './AuditLogPage';

/** The Admin audit log viewer (AD-51): read-only, safe metadata only, filters and Load More. Synthetic data only. */
afterEach(() => vi.unstubAllGlobals());

const ADMIN_ID = '01a181df-0000-7000-8000-000000000001';
const entry = (id: number, overrides: object = {}) => ({
  id: String(id),
  occurredAt: '2031-02-03T10:15:00Z',
  actorType: 'Staff',
  actorId: ADMIN_ID,
  actorKnown: true,
  actorName: 'Synthetic Admin',
  actorCurrentRole: 'Admin',
  operation: 'UPDATE',
  table: 'fields',
  entityId: `01a1aaaa-0000-7000-8000-${String(id).padStart(12, '0')}`,
  ...overrides,
});

const auditCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/api/admin/audit-logs'));

function api(answer: (url: string) => [number, unknown?]) {
  return mockFetch((_method, url) => answer(url));
}

const open = (i18n = testI18n(null, 'en')) => renderPage(<AuditLogPage />, { i18n });

const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('AuditLogPage', () => {
  it('lists entries read-only, with only the safe metadata, never stored values', async () => {
    const fetchMock = api(() => [
      200,
      {
        hasMore: false,
        entries: [
          // Anything else a response might carry is never shown.
          entry(12, {
            newValues: { code_hash: 'SECRET-HASH' },
            oldValues: { phone: 'SYNTHETIC-PHONE-555' },
          }),
          entry(11, {
            actorType: 'Anonymous',
            actorId: null,
            actorKnown: false,
            actorName: null,
            actorCurrentRole: null,
            operation: 'INSERT',
            table: 'user_sessions',
            entityId: null,
          }),
        ],
      },
    ]);
    open();
    await screen.findByRole('table');
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'admin.auditLog.number',
      'admin.auditLog.time',
      'admin.auditLog.actor',
      'admin.auditLog.operation',
      'admin.auditLog.table',
      'admin.auditLog.record',
    ]);
    const [first, second] = rows();
    expect(within(first!).getByText('12')).toBeInTheDocument();
    expect(within(first!).getByText('Synthetic Admin')).toBeInTheDocument();
    expect(within(first!).getByText('admin.auditLog.staffCurrentRole')).toBeInTheDocument();
    expect(within(first!).getByText(ADMIN_ID)).toBeInTheDocument();
    expect(within(first!).getByText('admin.auditLog.operations.UPDATE')).toBeInTheDocument();
    expect(within(first!).getByText('admin.auditLog.tables.fields')).toBeInTheDocument();
    expect(within(second!).getByText('admin.auditLog.actorTypes.Anonymous')).toBeInTheDocument();
    expect(within(second!).getByText('admin.auditLog.recordHidden')).toBeInTheDocument();

    expect(document.body.textContent).not.toMatch(
      /SECRET-HASH|SYNTHETIC-PHONE-555|code_hash|phone/,
    );
    // Read-only: one GET, and no action buttons (no create, edit, delete, clear or restore).
    expect(auditCalls(fetchMock)).toEqual(['/api/admin/audit-logs']);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies each filter, and the date range as whole local days', async () => {
    const fetchMock = api(() => [200, { hasMore: false, entries: [entry(1)] }]);
    open();
    const user = userEvent.setup();
    await screen.findByRole('table');
    const last = () => auditCalls(fetchMock).at(-1)!;

    await user.selectOptions(screen.getByLabelText('admin.auditLog.operation'), 'INSERT');
    await waitFor(() => expect(last()).toBe('/api/admin/audit-logs?operation=INSERT'));
    await user.selectOptions(screen.getByLabelText('admin.auditLog.table'), 'contact_logs');
    await waitFor(() =>
      expect(last()).toBe('/api/admin/audit-logs?operation=INSERT&table=contact_logs'),
    );
    await user.selectOptions(screen.getByLabelText('admin.auditLog.actorType'), 'Staff');
    await waitFor(() =>
      expect(last()).toBe(
        '/api/admin/audit-logs?operation=INSERT&table=contact_logs&actorType=Staff',
      ),
    );

    // Actor id: applied only when complete.
    const actor = screen.getByLabelText('admin.auditLog.actorId');
    const calls = auditCalls(fetchMock).length;
    await user.type(actor, '01a181df');
    expect(actor).toHaveAttribute('aria-invalid', 'true');
    expect(actor).toHaveAccessibleDescription('admin.auditLog.actorIdInvalid');
    expect(auditCalls(fetchMock)).toHaveLength(calls);
    await user.clear(actor);
    await user.type(actor, ADMIN_ID.toUpperCase());
    await waitFor(() => expect(last()).toContain(`actorId=${ADMIN_ID}`));
    expect(actor).toHaveAttribute('aria-invalid', 'false');

    // Dates: from the start of the first day to the start of the day after the last, on this device.
    await user.type(screen.getByLabelText('admin.auditLog.from'), '2031-02-01');
    await user.type(screen.getByLabelText('admin.auditLog.to'), '2031-02-03');
    const from = new Date(2031, 1, 1).toISOString();
    const to = new Date(2031, 1, 4).toISOString();
    await waitFor(() => {
      const query = new URLSearchParams(last().split('?')[1]);
      expect(query.get('from')).toBe(from);
      expect(query.get('to')).toBe(to);
    });
    expect(Object.fromEntries(new URLSearchParams(last().split('?')[1]))).toEqual({
      operation: 'INSERT',
      table: 'contact_logs',
      actorType: 'Staff',
      actorId: ADMIN_ID,
      from,
      to,
    });

    // Back to any operation.
    await user.selectOptions(screen.getByLabelText('admin.auditLog.operation'), '');
    await waitFor(() => expect(last()).not.toContain('operation='));
  });

  it('flags an end date before the start and does not apply it', async () => {
    const fetchMock = api(() => [200, { hasMore: false, entries: [entry(1)] }]);
    open();
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.type(screen.getByLabelText('admin.auditLog.from'), '2031-02-10');
    await user.type(screen.getByLabelText('admin.auditLog.to'), '2031-02-01');
    const to = screen.getByLabelText('admin.auditLog.to');
    expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(to).toHaveAccessibleDescription('admin.auditLog.rangeInvalid');
    expect(auditCalls(fetchMock).some((url) => url.includes('to='))).toBe(false);
  });

  it('loads older entries after the last one shown, without repeats, until there are no more', async () => {
    const fetchMock = api((url) =>
      url.includes('before=11')
        ? [200, { hasMore: false, entries: [entry(11), entry(10), entry(9)] }] // 11 again: shown once
        : [200, { hasMore: true, entries: [entry(12), entry(11)] }],
    );
    open();
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'admin.auditLog.loadMore' }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(rows().map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      '12',
      '11',
      '10',
      '9',
    ]);
    expect(auditCalls(fetchMock).at(-1)).toBe('/api/admin/audit-logs?before=11');
    expect(
      screen.queryByRole('button', { name: 'admin.auditLog.loadMore' }),
    ).not.toBeInTheDocument();
  });

  it('keeps what is shown when an older page fails', async () => {
    api((url) =>
      url.includes('before=')
        ? [500, { detail: 'Stack trace' }]
        : [200, { hasMore: true, entries: [entry(2)] }],
    );
    open();
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'admin.auditLog.loadMore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.auditLog.loadFailed');
    expect(rows()).toHaveLength(1);
    expect(screen.queryByText(/Stack trace/)).not.toBeInTheDocument();
  });

  it('says when there is nothing, and shows a load error without details', async () => {
    api(() => [200, { hasMore: false, entries: [] }]);
    const first = open();
    expect(await screen.findByText('admin.auditLog.empty')).toBeInTheDocument();
    first.unmount();

    api(() => [500, { detail: 'Stack trace', code: 'internal' }]);
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('admin.auditLog.loadFailed');
    expect(screen.queryByText(/Stack trace|internal|500/)).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'سجل التغييرات', 'تعديل', 'المجالات', 'موظف · الدور الحالي: المدير', 'مخفي'],
    ['en', enMessages, 'Audit log', 'Changed', 'Fields', 'Staff · current role: Admin', 'Hidden'],
  ] as const)('reads in %s', async (language, raw, title, changed, fields, staff, hidden) => {
    api(() => [
      200,
      {
        hasMore: false,
        entries: [entry(2), entry(1, { table: 'trainee_sign_in_codes', entityId: null })],
      },
    ]);
    open(testI18n(JSON.parse(raw), language));
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    const [first, second] = rows();
    expect(within(first!).getByText(changed)).toBeInTheDocument();
    expect(within(first!).getByText(fields)).toBeInTheDocument();
    expect(within(first!).getByText(staff)).toBeInTheDocument();
    expect(within(second!).getByText(hidden)).toBeInTheDocument();
  });

  describe('who acted', () => {
    const none = { actorId: null, actorKnown: false, actorName: null, actorCurrentRole: null };
    const cases = [
      entry(9, {
        actorId: '01a1bbbb-0000-7000-8000-000000000009',
        actorName: 'Synthetic HR',
        actorCurrentRole: 'HR',
      }),
      entry(8, {
        actorType: 'Trainee',
        actorId: '01a1cccc-0000-7000-8000-000000000008',
        actorName: 'Synthetic Trainee',
        actorCurrentRole: null,
      }),
      entry(7, {
        actorType: 'Trainee',
        actorId: '01a1cccc-0000-7000-8000-000000000007',
        actorName: null,
        actorCurrentRole: null,
      }),
      entry(6, {
        actorType: 'Staff',
        actorId: '01a1dddd-0000-7000-8000-000000000006',
        actorKnown: false,
        actorName: null,
        actorCurrentRole: null,
      }),
      entry(5, { actorType: 'Anonymous', ...none }),
      entry(4, { actorType: 'System', ...none }),
      entry(3, { actorType: 'Database', ...none }),
    ];
    const actorLines = () =>
      rows().map((r) =>
        Array.from(within(r).getAllByRole('cell')[2]!.querySelectorAll('span')).map(
          (span) => span.textContent,
        ),
      );

    it.each([
      [
        'en',
        enMessages,
        [
          ['Synthetic HR', 'Staff · current role: HR', '01a1bbbb-0000-7000-8000-000000000009'],
          ['Synthetic Trainee', 'Trainee', '01a1cccc-0000-7000-8000-000000000008'],
          ['Trainee (name not entered yet)', 'Trainee', '01a1cccc-0000-7000-8000-000000000007'],
          ['Unknown user', 'Staff', '01a1dddd-0000-7000-8000-000000000006'],
          ['Not signed in'],
          ['System'],
          ['Database'],
        ],
      ],
      [
        'ar',
        arMessages,
        [
          [
            'Synthetic HR',
            'موظف · الدور الحالي: الموارد البشرية',
            '01a1bbbb-0000-7000-8000-000000000009',
          ],
          ['Synthetic Trainee', 'متدرب', '01a1cccc-0000-7000-8000-000000000008'],
          ['متدرب (لم يُدخل اسمه بعد)', 'متدرب', '01a1cccc-0000-7000-8000-000000000007'],
          ['مستخدم غير معروف', 'موظف', '01a1dddd-0000-7000-8000-000000000006'],
          ['غير مسجّل الدخول'],
          ['النظام'],
          ['قاعدة البيانات'],
        ],
      ],
    ] as const)('names each kind of actor, name first (%s)', async (language, raw, expected) => {
      api(() => [200, { hasMore: false, entries: cases }]);
      open(testI18n(JSON.parse(raw), language));
      await screen.findByRole('table');
      expect(actorLines()).toEqual(expected);
      // The name is the prominent line; the recorded id is secondary.
      const firstLines = within(rows()[0]!).getAllByRole('cell')[2]!.querySelectorAll('span');
      expect(firstLines[0]!.className).toContain('font-semibold');
      expect(firstLines[2]!.className).toContain('text-muted');
    });

    it('keeps names when older entries are loaded', async () => {
      api((url) =>
        url.includes('before=')
          ? [200, { hasMore: false, entries: [cases[1]] }]
          : [200, { hasMore: true, entries: [cases[0]] }],
      );
      open();
      const user = userEvent.setup();
      await screen.findByRole('table');
      await user.click(screen.getByRole('button', { name: 'admin.auditLog.loadMore' }));
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(within(rows()[0]!).getByText('Synthetic HR')).toBeInTheDocument();
      expect(within(rows()[1]!).getByText('Synthetic Trainee')).toBeInTheDocument();
    });
  });

  it('lays out with logical (RTL/LTR-neutral) classes only', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
  });
});

describe('reaching the audit log', () => {
  const signedIn = (role: UserRole): SessionUser => ({
    id: ADMIN_ID,
    role,
    email: 'someone@stu.najah.edu',
    name: 'Someone',
  });

  it('Admin: the Audit log page in the Admin navigation', async () => {
    const fetchMock = api((url) =>
      url.startsWith('/api/admin/audit-logs')
        ? [200, { hasMore: false, entries: [entry(1)] }]
        : [200, []],
    );
    const { router } = renderRoutes(routes, {
      url: '/admin/fields',
      auth: fakeAuth({ user: signedIn('Admin') }),
    });
    const nav = await screen.findByRole('navigation', { name: 'admin.nav.label' });
    await userEvent
      .setup()
      .click(within(nav).getAllByRole('link', { name: 'admin.nav.auditLog' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/audit-log'));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(auditCalls(fetchMock)).toEqual(['/api/admin/audit-logs']);
  });

  it.each(['HR', 'Employee', 'Trainee'] as const)(
    'is neither offered to nor opened for %s',
    async (role) => {
      const fetchMock = api(() => [200, []]);
      const { router } = renderRoutes(routes, {
        url: '/admin/audit-log',
        auth: fakeAuth({ user: signedIn(role) }),
      });
      await waitFor(() => expect(router.state.location.pathname).not.toBe('/admin/audit-log'));
      expect(screen.queryByRole('link', { name: 'admin.nav.auditLog' })).not.toBeInTheDocument();
      expect(auditCalls(fetchMock)).toEqual([]);
    },
  );
});
