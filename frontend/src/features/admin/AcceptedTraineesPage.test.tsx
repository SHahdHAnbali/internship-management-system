import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import enMessages from '../../../public/i18n/en.json?raw';
import arMessages from '../../../public/i18n/ar.json?raw';
import { mockFetch, renderPage, testI18n } from '../../test/render';
import { AcceptedTraineesPage } from './AcceptedTraineesPage';
import { adminCache } from './adminCache';

beforeEach(() => adminCache.clear());
afterEach(() => vi.unstubAllGlobals());

const accepted = (overrides: object = {}) => ({
  applicationId: 'a1',
  trainee: {
    fullName: 'Lina Haddad',
    university: 'An-Najah National University',
    major: 'Computer Engineering',
    studyYear: 'Fourth year',
  },
  fieldName: 'QA',
  availableFrom: '2027-02-01',
  availableTo: '2027-04-30',
  hours: 240,
  mandatoryForUniversity: true,
  acceptedAt: '2026-10-30T10:00:00Z',
  assignments: [],
  responsibleHr: {
    acceptedBy: { id: 'hr-a', fullName: 'HR Alpha' },
    current: { id: 'hr-a', fullName: 'HR Alpha', isHr: true },
    changes: [] as object[],
  },
  ...overrides,
});

describe('AcceptedTraineesPage', () => {
  it('lists the accepted trainees with their recorded assignments and responsible HR', async () => {
    const fetchMock = mockFetch(() => [
      200,
      [
        accepted(),
        accepted({
          applicationId: 'a2',
          trainee: { fullName: 'Omar Saleh', university: 'Birzeit University' },
          assignments: [
            {
              employeeName: 'Mentor One',
              status: 'Active',
              startDate: '2027-02-01',
              endDate: '2027-04-30',
            },
          ],
        }),
      ],
    ]);
    renderPage(<AcceptedTraineesPage />);

    const lina = (await screen.findByText('Lina Haddad')).closest('tr')!;
    expect(within(lina).getByText('admin.acceptedTrainees.noAssignment')).toBeInTheDocument();
    expect(within(lina).getByText('An-Najah National University')).toBeInTheDocument();
    const omar = screen.getByText('Omar Saleh').closest('tr')!;
    expect(within(omar).getByText('Mentor One')).toBeInTheDocument();
    expect(within(omar).getByText('training.assignmentStatus.Active')).toBeInTheDocument();

    // Owner decision C5: no e-mail, phone or CV.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('training.profile.email');
    expect(headers).not.toContain('training.profile.phone');
    expect(screen.queryByText(/training\.attachmentKind\.Cv/)).not.toBeInTheDocument();

    // One GET; the only action is changing the responsible HR (AD-64); no text inputs.
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
      'GET /api/admin/accepted-trainees',
    ]);
    expect(within(lina).getByText('HR Alpha')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'admin.acceptedTrainees.changeFor',
      'admin.acceptedTrainees.changeFor',
    ]);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    mockFetch(() => [200, []]);
    renderPage(<AcceptedTraineesPage />);
    expect(await screen.findByText('admin.acceptedTrainees.empty')).toBeInTheDocument();
  });

  it('shows a load error without technical details', async () => {
    mockFetch(() => [500, { status: 500, detail: 'Stack trace' }]);
    renderPage(<AcceptedTraineesPage />);
    expect(await screen.findByText('admin.errors.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(/Stack trace|500/)).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'المتدربون المقبولون', 'لا يوجد ربط بعد'],
    ['en', enMessages, 'Accepted trainees', 'No assignment yet'],
  ] as const)('reads in %s', async (language, raw, title, none) => {
    mockFetch(() => [200, [accepted()]]);
    renderPage(<AcceptedTraineesPage />, { i18n: testI18n(JSON.parse(raw), language) });
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(await screen.findByText(none)).toBeInTheDocument();
  });
});

describe('AcceptedTraineesPage: responsible HR (AD-64)', () => {
  const users = [
    { id: 'hr-a', fullName: 'HR Alpha', email: 'a@x', department: null, role: 'HR' },
    { id: 'hr-b', fullName: 'HR Beta', email: 'b@x', department: null, role: 'HR' },
    { id: 'emp', fullName: 'Employee One', email: 'e@x', department: null, role: 'Employee' },
    { id: 'adm', fullName: 'Admin One', email: 'm@x', department: null, role: 'Admin' },
  ];
  const replaced = accepted({
    responsibleHr: {
      acceptedBy: { id: 'hr-a', fullName: 'HR Alpha' },
      current: { id: 'hr-b', fullName: 'HR Beta', isHr: true },
      changes: [
        {
          sequence: 1,
          hr: { id: 'hr-b', fullName: 'HR Beta' },
          changedBy: 'Admin One',
          changedAt: '2026-11-13T09:00:00Z',
        },
      ],
    },
  });
  const calls = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);

  async function open() {
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'admin.acceptedTrainees.changeFor' }),
    );
    const dialog = await screen.findByRole('dialog');
    return { user, dialog };
  }

  it('offers only users who hold the HR role now, reviews, confirms once and shows the new responsible HR', async () => {
    const fetchMock = mockFetch((method, url) => {
      if (url === '/api/admin/users') return [200, users];
      return method === 'PUT' ? [200, replaced] : [200, [accepted()]];
    });
    renderPage(<AcceptedTraineesPage />);
    const { user, dialog } = await open();

    expect(within(dialog).getByText('admin.acceptedTrainees.acceptedBy')).toBeInTheDocument();
    const select = within(dialog).getByLabelText(/admin.acceptedTrainees.newHr/);
    await waitFor(() => expect(select).toBeEnabled());
    // HR Alpha is already responsible; Employee and Admin users are not offered.
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['admin.acceptedTrainees.chooseHr', 'HR Beta']);

    await user.click(within(dialog).getByRole('button', { name: 'admin.acceptedTrainees.review' }));
    expect(within(dialog).getByText('admin.acceptedTrainees.errors.chooseHr')).toBeInTheDocument();
    expect(select).toHaveAttribute('aria-invalid', 'true');

    await user.selectOptions(select, 'hr-b');
    await user.click(within(dialog).getByRole('button', { name: 'admin.acceptedTrainees.review' }));
    expect(within(dialog).getByText('admin.acceptedTrainees.reviewText')).toBeInTheDocument();
    await user.dblClick(
      within(dialog).getByRole('button', { name: 'admin.acceptedTrainees.confirm' }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = screen.getByText('Lina Haddad').closest('tr')!;
    expect(within(row).getByText('HR Beta')).toBeInTheDocument();
    expect(calls(fetchMock).filter((c) => c.startsWith('PUT'))).toEqual([
      'PUT /api/admin/accepted-trainees/a1/responsible-hr',
    ]);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ hrId: 'hr-b' });
  });

  it('marks a responsible HR who is no longer HR, explains it, and lists earlier appointments', async () => {
    mockFetch((_method, url) =>
      url === '/api/admin/users'
        ? [200, users]
        : [
            200,
            [
              accepted({
                responsibleHr: {
                  ...replaced.responsibleHr,
                  current: { id: 'hr-b', fullName: 'HR Beta', isHr: false },
                },
              }),
            ],
          ],
    );
    renderPage(<AcceptedTraineesPage />);
    const row = (await screen.findByText('Lina Haddad')).closest('tr')!;
    expect(within(row).getByText('admin.acceptedTrainees.notHr')).toBeInTheDocument();
    const { dialog } = await open();
    expect(within(dialog).getByText('admin.acceptedTrainees.noRecipient')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    const select = within(dialog).getByLabelText(/admin.acceptedTrainees.newHr/);
    // The former HR is not current HR, so every HR user is offered.
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['admin.acceptedTrainees.chooseHr', 'HR Alpha', 'HR Beta']),
    );
  });

  it('a refusal (the chosen user is no longer HR) is explained, the dialog closes and the list reloads', async () => {
    const fetchMock = mockFetch((method, url) => {
      if (url === '/api/admin/users') return [200, users];
      return method === 'PUT'
        ? [400, { status: 400, code: 'responsible_hr.not_hr', detail: 'technical detail' }]
        : [200, [accepted()]];
    });
    renderPage(<AcceptedTraineesPage />);
    const { user, dialog } = await open();
    const select = within(dialog).getByLabelText(/admin.acceptedTrainees.newHr/);
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, 'hr-b');
    await user.click(within(dialog).getByRole('button', { name: 'admin.acceptedTrainees.review' }));
    await user.click(
      within(dialog).getByRole('button', { name: 'admin.acceptedTrainees.confirm' }),
    );

    expect(await screen.findByText('admin.acceptedTrainees.errors.notHr')).toBeInTheDocument();
    expect(screen.queryByText('technical detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(calls(fetchMock).filter((c) => c === 'GET /api/admin/accepted-trainees')).toHaveLength(
        2,
      ),
    );
  });

  it.each([
    [
      'ar',
      arMessages,
      'مسؤول الموارد البشرية',
      'تغيير مسؤول الموارد البشرية للمتدرب Lina Haddad',
      'مسؤول الموارد البشرية الجديد',
    ],
    [
      'en',
      enMessages,
      'Responsible HR',
      'Change the responsible HR of Lina Haddad',
      'New responsible HR',
    ],
  ] as const)('reads in %s', async (language, raw, header, button, label) => {
    mockFetch((_method, url) => (url === '/api/admin/users' ? [200, users] : [200, [accepted()]]));
    renderPage(<AcceptedTraineesPage />, { i18n: testI18n(JSON.parse(raw), language) });
    expect(await screen.findByRole('columnheader', { name: header })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: button }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(new RegExp(label))).toBeInTheDocument();
  });
});
