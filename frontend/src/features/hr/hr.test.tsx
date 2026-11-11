import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { fakeAuth, mockFetch, renderRoutes, renderPage, testI18n } from '../../test/render';
import { ApplicationDetailPage } from './ApplicationDetailPage';
import { MentorRequestsPage } from './MentorRequestsPage';
import { HrArea } from './HrArea';
import { ReportsPage } from './ReportsPage';
import { TraineeHistoryReport } from './TraineeHistoryReport';
import { TrainingsPage } from './TrainingsPage';

afterEach(() => vi.unstubAllGlobals());

const application = (status: string) => ({
  id: 'a1',
  status,
  field: { id: 'f1', name: 'Backend' },
  trainee: {
    id: 't1',
    email: 'lina@trainee.example',
    fullName: 'Lina Haddad',
    phone: '000',
    university: 'Example University',
    major: 'CE',
    studyYear: '4',
  },
  availableFrom: '2027-02-01',
  availableTo: '2027-04-30',
  hours: 240,
  mandatoryForUniversity: true,
  submittedAt: '2026-10-29T10:00:00Z',
  decidedAt: null,
  rejectionReason: null,
  attachments: [{ id: 'x1', kind: 'Cv', fileName: 'cv.pdf', sizeBytes: 4 }],
});

/** GET of the contact log answers an empty list; everything else is up to the test. */
const withLog =
  (handler: (method: string, url: string) => [number, unknown?]) =>
  (method: string, url: string) =>
    url.endsWith('/contact-logs') && method === 'GET'
      ? ([200, []] as [number, unknown])
      : handler(method, url);

const page = () =>
  renderRoutes([{ path: '/hr/applications/:id', element: <ApplicationDetailPage /> }], {
    url: '/hr/applications/a1',
  });

describe('HR application review', () => {
  it('puts a submitted application under review, then accepts it', async () => {
    let status = 'Submitted';
    const fetchMock = mockFetch(
      withLog((_method, url) => {
        if (url.endsWith('/review')) status = 'UnderReview';
        if (url.endsWith('/accept')) status = 'Accepted';
        return [200, application(status)];
      }),
    );
    page();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'hr.applications.review' }));
    expect(await screen.findByText('training.applicationStatus.UnderReview')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'hr.applications.review' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'hr.applications.accept' }));
    expect(await screen.findByText('training.applicationStatus.Accepted')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'hr.applications.accept' }),
    ).not.toBeInTheDocument(); // final
    const calls = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /api/hr/applications/a1/review',
      'POST /api/hr/applications/a1/accept',
    ]); // no contact-log entry was needed to decide
  });

  it('rejects only with a reason', async () => {
    const fetchMock = mockFetch(
      withLog((method) =>
        method === 'POST'
          ? [200, { ...application('Rejected'), rejectionReason: 'Period is full' }]
          : [200, application('Submitted')],
      ),
    );
    page();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'hr.applications.reject' }));
    const dialogReject = screen.getAllByRole('button', { name: 'hr.applications.reject' }).at(-1)!;
    await user.click(dialogReject);
    expect(screen.getByRole('alert')).toHaveTextContent('hr.applications.reasonRequired');
    await user.type(screen.getByLabelText('hr.applications.rejectionReason'), 'Period is full');
    await user.click(screen.getAllByRole('button', { name: 'hr.applications.reject' }).at(-1)!);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/hr/applications/a1/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'Period is full' }),
        }),
      ),
    );
    expect(await screen.findByText('Period is full')).toBeInTheDocument();
  });
});

describe('HR contact log', () => {
  it('records a contact with its date, method and summary, and lists the entries', async () => {
    let entries: unknown[] = [];
    const fetchMock = mockFetch((method, url) => {
      if (url.endsWith('/contact-logs'))
        if (method === 'POST') {
          entries = [
            {
              id: 'c1',
              contactDate: '2026-10-28',
              method: 'Phone',
              summary: 'Agreed on the period.',
              recordedAt: '2026-10-29T10:00:00Z',
              authorName: 'HR One',
            },
          ];
          return [201, entries[0]];
        } else return [200, entries];
      return [200, application('UnderReview')];
    });
    page();
    const user = userEvent.setup();

    expect(await screen.findByText('hr.contactLog.empty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'hr.contactLog.add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('hr.contactLog.required');

    await user.type(screen.getByLabelText('hr.contactLog.date'), '2026-10-28');
    await user.selectOptions(screen.getByLabelText('hr.contactLog.method'), 'Phone');
    await user.type(screen.getByLabelText('hr.contactLog.summary'), 'Agreed on the period.');
    await user.click(screen.getByRole('button', { name: 'hr.contactLog.add' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/hr/applications/a1/contact-logs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            contactDate: '2026-10-28',
            method: 'Phone',
            summary: 'Agreed on the period.',
          }),
        }),
      ),
    );
    expect(await screen.findByText('Agreed on the period.')).toBeInTheDocument();
    // The decision buttons do not wait for an entry.
    expect(screen.getByRole('button', { name: 'hr.applications.accept' })).toBeEnabled();
  });
});

describe('HR mentor requests', () => {
  it("approves a request with the training dates (prefilled from the trainee's period), or rejects it", async () => {
    const request = {
      id: 'r1',
      status: 'Pending',
      note: 'Build the reporting API',
      requestedAt: '2026-10-29T10:00:00Z',
      decidedAt: null,
      employee: { id: 'e1', fullName: 'Employee One', email: 'e@stu.najah.edu' },
      application: {
        id: 'a1',
        traineeName: 'Lina Haddad',
        fieldName: 'Backend',
        availableFrom: '2027-02-01',
        availableTo: '2027-04-30',
      },
    };
    const fetchMock = mockFetch((method) =>
      method === 'POST' ? [200, { ...request, status: 'Approved' }] : [200, [request]],
    );
    renderPage(<MentorRequestsPage />);
    const user = userEvent.setup();

    expect(await screen.findByText('Build the reporting API')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'hr.mentorRequests.approve' }));
    expect(screen.getByLabelText('hr.mentorRequests.startDate')).toHaveValue('2027-02-01');
    await user.clear(screen.getByLabelText('hr.mentorRequests.startDate'));
    await user.type(screen.getByLabelText('hr.mentorRequests.startDate'), '2027-02-03');
    await user.click(screen.getAllByRole('button', { name: 'hr.mentorRequests.approve' }).at(-1)!);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/hr/mentor-requests/r1/approve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ startDate: '2027-02-03', endDate: '2027-04-30' }),
        }),
      ),
    );
  });
});

describe('HR trainings', () => {
  const assignment = (id: string, status: string, trainee: string) => ({
    id,
    applicationId: `app-${id}`,
    status,
    startDate: '2027-02-01',
    endDate: '2027-04-30',
    endReason: null as string | null,
    trainee: { id: `t-${id}`, fullName: trainee, email: `${id}@trainee.example` },
    employee: { id: 'e1', fullName: 'Mentor One', email: 'mentor@company.example' },
    fieldName: 'QA',
  });

  it('separates current (Active) from previous trainings and shows the recorded details', async () => {
    const fetchMock = mockFetch(() => [
      200,
      [
        assignment('s1', 'Active', 'Lina Haddad'),
        assignment('s2', 'Completed', 'Omar Saleh'),
        assignment('s3', 'Transferred', 'Sara Khalil'),
      ],
    ]);
    renderPage(<TrainingsPage />);

    const current = await screen.findByRole('region', { name: 'hr.trainings.current' });
    const previous = screen.getByRole('region', { name: 'hr.trainings.previous' });
    const lina = within(current).getByText('Lina Haddad').closest('tr')!;
    expect(within(lina).getByText('Mentor One')).toBeInTheDocument();
    expect(within(lina).getByText('QA')).toBeInTheDocument();
    expect(within(lina).getByText('training.assignmentStatus.Active')).toBeInTheDocument();
    expect(within(current).queryByText('Omar Saleh')).not.toBeInTheDocument();
    expect(within(previous).getByText('training.assignmentStatus.Completed')).toBeInTheDocument();
    expect(within(previous).getByText('training.assignmentStatus.Transferred')).toBeInTheDocument();

    // One GET; the only action is "End training" on the current (Active) training, none on previous ones.
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
      'GET /api/hr/assignments',
    ]);
    expect(within(current).getAllByRole('button')).toHaveLength(1);
    expect(
      within(current).getByRole('button', { name: 'hr.trainings.endFor' }),
    ).toBeInTheDocument();
    expect(within(previous).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says when there are no trainings, and shows a load error without details', async () => {
    mockFetch(() => [200, []]);
    const { unmount } = renderPage(<TrainingsPage />);
    expect(await screen.findByText('hr.trainings.noCurrent')).toBeInTheDocument();
    expect(screen.getByText('hr.trainings.noPrevious')).toBeInTheDocument();
    unmount();

    mockFetch(() => [500, { detail: 'Stack trace' }]);
    renderPage(<TrainingsPage />);
    expect(await screen.findByText('training.errors.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(/Stack trace/)).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'التدريبات الجارية', 'قيد التدريب'],
    ['en', enMessages, 'Current trainings', 'In training'],
  ] as const)('reads in %s', async (language, raw, heading, active) => {
    mockFetch(() => [200, [assignment('s1', 'Active', 'Lina Haddad')]]);
    renderPage(<TrainingsPage />, { i18n: testI18n(JSON.parse(raw), language) });
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByText(active)).toBeInTheDocument();
  });
});

describe('HR ends a training (AD-63 Phase 1)', () => {
  const active = (startDate: string, endDate: string) => ({
    id: 's1',
    applicationId: 'app-s1',
    status: 'Active',
    startDate,
    endDate,
    endReason: null as string | null,
    trainee: { id: 't1', fullName: 'Lina Haddad', email: 'lina@trainee.example' },
    employee: { id: 'e1', fullName: 'Mentor One', email: 'mentor@company.example' },
    fieldName: 'QA',
  });

  /** Answers the list with `row`, and every POST with `post`. */
  function api(row: ReturnType<typeof active>, post: () => [number, unknown?]) {
    return mockFetch((method) => (method === 'POST' ? post() : [200, [row]]));
  }
  const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url, init]) => [url, JSON.parse(String(init!.body))]);

  async function openDialog() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'hr.trainings.endFor' }));
    return { user, dialog: await screen.findByRole('dialog') };
  }
  const setDate = (dialog: HTMLElement, value: string) =>
    fireEvent.change(within(dialog).getByLabelText('hr.trainings.actualEndDate'), {
      target: { value },
    });

  it('normal completion: on or after the planned end date, no reason, reviewed then confirmed once', async () => {
    const fetchMock = api(active('2020-01-01', '2020-03-31'), () => [200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByLabelText('hr.trainings.kind.completion'));
    setDate(dialog, '2020-03-31');
    expect(within(dialog).getByRole('status')).toHaveTextContent('hr.trainings.willBe');
    expect(within(dialog).queryByLabelText('hr.trainings.reason')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));

    expect(within(dialog).getByText('training.assignmentStatus.Completed')).toBeInTheDocument();
    await user.dblClick(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    await waitFor(() => expect(screen.getByText('hr.trainings.ended')).toBeInTheDocument());
    expect(posts(fetchMock)).toEqual([
      ['/api/hr/assignments/s1/complete', { endDate: '2020-03-31', reason: null }],
    ]);
  });

  it('early completion: before the planned end date it becomes Ended early and needs a reason', async () => {
    const fetchMock = api(active('2020-01-01', '2999-12-31'), () => [200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByLabelText('hr.trainings.kind.completion'));
    setDate(dialog, '2024-05-01');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    const reason = within(dialog).getByLabelText('hr.trainings.reason');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('hr.trainings.errors.reason');
    expect(reason.getAttribute('aria-describedby')).toBe(alert.id);

    await user.type(reason, '  Finished the project early  ');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('training.assignmentStatus.EndedEarly')).toBeInTheDocument();
    expect(within(dialog).getByText('Finished the project early')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    await waitFor(() =>
      expect(posts(fetchMock)).toEqual([
        [
          '/api/hr/assignments/s1/complete',
          { endDate: '2024-05-01', reason: 'Finished the project early' },
        ],
      ]),
    );
  });

  it('withdrawal: a reason is required; Back returns to the form without sending anything', async () => {
    const fetchMock = api(active('2020-01-01', '2999-12-31'), () => [200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByLabelText('hr.trainings.kind.withdrawal'));
    setDate(dialog, '2020-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('hr.trainings.errors.reason');
    await user.type(within(dialog).getByLabelText('hr.trainings.reason'), 'Moved away');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('training.assignmentStatus.Withdrawn')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.back' }));
    expect(posts(fetchMock)).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    await waitFor(() =>
      expect(posts(fetchMock)).toEqual([
        ['/api/hr/assignments/s1/withdraw', { endDate: '2020-01-01', reason: 'Moved away' }],
      ]),
    );
  });

  it('checks the outcome and the date before review: required, not before the start, not in the future', async () => {
    const fetchMock = api(active('2020-01-01', '2999-12-31'), () => [200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openDialog();
    const date = within(dialog).getByLabelText('hr.trainings.actualEndDate');
    expect(date).toHaveAttribute('min', '2020-01-01');
    expect(date.getAttribute('max')).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('hr.trainings.errors.kind')).toBeInTheDocument();
    expect(within(dialog).getByText('hr.trainings.errors.date')).toBeInTheDocument();

    await user.click(within(dialog).getByLabelText('hr.trainings.kind.withdrawal'));
    for (const [value, error] of [
      ['2019-12-31', 'hr.trainings.errors.dateBeforeStart'],
      ['2999-01-01', 'hr.trainings.errors.dateInFuture'],
    ] as const) {
      setDate(dialog, value);
      await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
      expect(within(dialog).getByText(error)).toBeInTheDocument();
      expect(date).toHaveAttribute('aria-invalid', 'true');
    }
    expect(posts(fetchMock)).toEqual([]);
  });

  it('a concurrent change (409) closes the dialog, says so and reloads; a server date error is shown in the form', async () => {
    const conflict = api(active('2020-01-01', '2020-03-31'), () => [409, { status: 409 }]);
    const { unmount } = renderPage(<TrainingsPage />);
    let { user, dialog } = await openDialog();
    await user.click(within(dialog).getByLabelText('hr.trainings.kind.completion'));
    setDate(dialog, '2020-04-01');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    expect(await screen.findByText('training.errors.conflict')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        conflict.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET'),
      ).toHaveLength(2),
    );
    unmount();

    api(active('2020-01-01', '2020-03-31'), () => [
      400,
      { status: 400, code: 'assignment.end_in_future' },
    ]);
    renderPage(<TrainingsPage />);
    ({ user, dialog } = await openDialog());
    await user.click(within(dialog).getByLabelText('hr.trainings.kind.completion'));
    setDate(dialog, '2020-04-01');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    expect(await within(dialog).findByText('hr.trainings.errors.dateInFuture')).toBeInTheDocument();
  });

  it('shows the recorded reason of previous trainings (HR page), as plain text', async () => {
    mockFetch(() => [
      200,
      [
        {
          ...active('2020-01-01', '2020-02-01'),
          status: 'Withdrawn',
          endReason: '<b>Left</b>\nfor work',
        },
      ],
    ]);
    renderPage(<TrainingsPage />);
    const previous = await screen.findByRole('region', { name: 'hr.trainings.previous' });
    const cell = within(previous).getByText(/<b>Left<\/b>/);
    expect(cell.textContent).toBe('<b>Left</b>\nfor work');
    expect(cell).toHaveAttribute('dir', 'auto');
    expect(previous.querySelector('b')).toBeNull();
  });

  it.each([
    ['ar', arMessages, 'إنهاء تدريب Lina Haddad', 'إكمال ناجح', 'تاريخ الانتهاء الفعلي'],
    [
      'en',
      enMessages,
      'End the training of Lina Haddad',
      'Successful completion',
      'Actual end date',
    ],
  ] as const)('reads in %s', async (language, raw, endButton, completion, dateLabel) => {
    mockFetch(() => [200, [active('2020-01-01', '2999-12-31')]]);
    renderPage(<TrainingsPage />, { i18n: testI18n(JSON.parse(raw), language) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: endButton }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(completion)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(dateLabel)).toBeInTheDocument();
  });
});

describe('HR navigation', () => {
  it('has Applications, Mentor requests, Trainings and Reports, and no separate Trainees tab', async () => {
    mockFetch(() => [200, { unreadCount: 0, hasMore: false, notifications: [] }]);
    renderRoutes([{ path: '/hr', element: <HrArea /> }], {
      url: '/hr',
      auth: fakeAuth({ user: { id: 'h1', role: 'HR', email: 'hr@company.example', name: null } }),
    });
    const nav = await screen.findByRole('navigation', { name: 'areas.navLabel' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['hr.nav.applications', '/hr/applications'],
      ['hr.nav.mentorRequests', '/hr/mentor-requests'],
      ['hr.nav.trainings', '/hr/trainings'],
      ['hr.nav.reports', '/hr/reports'],
    ]);
  });
});

describe('HR report: trainee history (PDF §6, read-only)', () => {
  const trainees = [
    {
      id: 't1',
      email: 'lina@trainee.example',
      fullName: 'Lina Haddad',
      university: 'U',
      applications: 2,
    },
    {
      id: 't2',
      email: 'omar@trainee.example',
      fullName: 'Omar Saleh',
      university: 'U',
      applications: 1,
    },
  ];
  const history = {
    totalTrainings: 1,
    trainee: {
      id: 't1',
      email: 'lina@trainee.example',
      fullName: 'Lina Haddad',
      phone: '000-0001',
      university: 'An-Najah National University',
      major: 'CE',
      studyYear: '4',
    },
    applications: [
      {
        id: 'a1',
        status: 'Rejected',
        fieldName: 'QA',
        availableFrom: '2027-02-01',
        availableTo: '2027-04-30',
        hours: 240,
        submittedAt: '2026-10-01T10:00:00Z',
        decidedAt: '2026-10-05T10:00:00Z',
        rejectionReason: 'Period is full',
        assignments: [],
        contactLogs: [
          {
            id: 'c1',
            contactDate: '2026-10-03',
            method: 'Phone',
            summary: 'Discussed the period.',
            recordedAt: '2026-10-03T10:00:00Z',
            authorName: 'HR One',
          },
        ],
      },
      {
        id: 'a2',
        status: 'Accepted',
        fieldName: 'full stack',
        availableFrom: '2027-06-01',
        availableTo: '2027-08-31',
        hours: 280,
        submittedAt: '2026-10-20T10:00:00Z',
        decidedAt: '2026-10-22T10:00:00Z',
        rejectionReason: null,
        assignments: [
          {
            id: 's1',
            employeeName: 'Mentor One',
            status: 'Active',
            startDate: '2027-06-01',
            endDate: '2027-08-31',
            endReason: null,
          },
        ],
        contactLogs: [
          {
            id: 'c2',
            contactDate: '2026-10-21',
            method: 'Email',
            summary: 'Confirmed the dates.',
            recordedAt: '2026-10-21T10:00:00Z',
            authorName: 'HR Two',
          },
        ],
      },
    ],
  };
  const api = (overrides: (url: string) => [number, unknown?] | null = () => null) =>
    mockFetch(
      (_m, url) =>
        overrides(url) ?? (url === '/api/hr/trainees' ? [200, trainees] : [200, history]),
    );
  const report = (url = '/hr/reports/trainee-history', i18n?: ReturnType<typeof testI18n>) =>
    renderRoutes([{ path: '/hr/reports/trainee-history', element: <TraineeHistoryReport /> }], {
      url,
      ...(i18n ? { i18n } : {}),
    });

  it('the Reports section lists the trainee history report', () => {
    renderPage(<ReportsPage />);
    expect(screen.getByRole('link', { name: 'hr.reports.traineeHistory.title' })).toHaveAttribute(
      'href',
      '/hr/reports/trainee-history',
    );
  });

  it('shows all trainings of the selected trainee and their contact notes, nothing else', async () => {
    const fetchMock = api();
    const { router } = report();
    const user = userEvent.setup();

    await user.selectOptions(
      await screen.findByLabelText('hr.reports.traineeHistory.trainee'),
      'Lina Haddad',
    );
    await waitFor(() => expect(router.state.location.search).toBe('?trainee=t1'));

    const trainings = await screen.findByRole('region', {
      name: 'hr.reports.traineeHistory.trainings',
    });
    const row = within(trainings).getByText('Mentor One').closest('tr')!;
    expect(within(row).getByText('full stack')).toBeInTheDocument();
    expect(within(row).getByText('training.assignmentStatus.Active')).toBeInTheDocument();
    expect(within(trainings).getAllByRole('row')).toHaveLength(2); // header + the one training

    const notes = screen.getByRole('region', { name: 'hr.reports.traineeHistory.contactNotes' });
    const noteRows = within(notes).getAllByRole('row').slice(1);
    expect(noteRows.map((r) => within(r).getAllByRole('cell')[2]!.textContent)).toEqual([
      'Confirmed the dates.',
      'Discussed the period.',
    ]); // all contact notes, newest first, from every application
    expect(within(noteRows[1]!).getByText('hr.contactLog.methods.Phone')).toBeInTheDocument();

    // A report, not the applications page: no contact details, decisions, links to applications or actions.
    expect(screen.queryByText('lina@trainee.example')).not.toBeInTheDocument();
    expect(screen.queryByText('000-0001')).not.toBeInTheDocument();
    expect(screen.queryByText('Period is full')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /openApplication/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'reports.export.xlsx',
      'reports.export.pdf',
    ]); // only the export buttons: no actions
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
      'GET /api/hr/trainees',
      'GET /api/hr/trainees/t1/history',
    ]);
  });

  it('opens directly for a trainee given in the address, with empty sections when nothing is recorded', async () => {
    api((url) =>
      url.endsWith('/history')
        ? [200, { ...history, applications: [{ ...history.applications[0], contactLogs: [] }] }]
        : null,
    );
    report('/hr/reports/trainee-history?trainee=t1');
    expect(await screen.findByText('hr.reports.traineeHistory.noTrainings')).toBeInTheDocument();
    expect(screen.getByText('hr.reports.traineeHistory.noContactNotes')).toBeInTheDocument();
    expect(screen.getByLabelText('hr.reports.traineeHistory.trainee')).toHaveValue('t1');
  });

  it('says when no trainee has applied, when the trainee is unknown, and when loading fails', async () => {
    api((url) => (url === '/api/hr/trainees' ? [200, []] : null));
    const first = report();
    expect(await screen.findByText('hr.reports.traineeHistory.noTrainees')).toBeInTheDocument();
    first.unmount();

    api((url) => (url.endsWith('/history') ? [404, { status: 404, code: 'not_found' }] : null));
    const second = report('/hr/reports/trainee-history?trainee=t9');
    expect(await screen.findByText('hr.reports.traineeHistory.notFound')).toBeInTheDocument();
    second.unmount();

    api((url) => (url.endsWith('/history') ? [500, { detail: 'Stack trace' }] : null));
    report('/hr/reports/trainee-history?trainee=t1');
    expect(await screen.findByText('training.errors.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(/Stack trace|not_found/)).not.toBeInTheDocument();
  });

  it('offers exactly the trainees the API returns (the API keeps only those with an Accepted application)', async () => {
    api();
    report();
    const select = await screen.findByLabelText('hr.reports.traineeHistory.trainee');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['', 't1', 't2']);
  });

  it.each([
    [
      'ar',
      arMessages,
      'لا يوجد متدرب لديه طلب مقبول بعد.',
      'هذا المتدرب غير مشمول في هذا التقرير.',
    ],
    [
      'en',
      enMessages,
      'No trainee has an accepted application yet.',
      'This trainee is not in this report.',
    ],
  ] as const)(
    'the empty and not-in-report states read in %s',
    async (language, raw, empty, notIn) => {
      const i18n = testI18n(JSON.parse(raw), language);
      api((url) => (url === '/api/hr/trainees' ? [200, []] : null));
      const first = report(undefined, i18n);
      expect(await screen.findByText(empty)).toBeInTheDocument();
      first.unmount();

      // A trainee without an Accepted application, given in the address: the API answers 404.
      api((url) => (url.endsWith('/history') ? [404, { status: 404, code: 'not_found' }] : null));
      report('/hr/reports/trainee-history?trainee=t9', i18n);
      expect(await screen.findByText(notIn)).toBeInTheDocument();
    },
  );

  it.each([
    ['ar', arMessages, 'سجل المتدرب', 'ملاحظات التواصل', 'هاتف'],
    ['en', enMessages, 'Trainee history', 'Contact notes', 'Phone'],
  ] as const)('reads in %s', async (language, raw, heading, notesHeading, phone) => {
    api();
    report('/hr/reports/trainee-history?trainee=t1', testI18n(JSON.parse(raw), language));
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: notesHeading })).toBeInTheDocument();
    expect(screen.getByText(phone)).toBeInTheDocument();
  });
});
