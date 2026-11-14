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
    extensions: [] as never[],
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
    expect(within(current).getAllByRole('button')).toHaveLength(2);
    expect(
      within(current).getByRole('button', { name: 'hr.trainings.endFor' }),
    ).toBeInTheDocument();
    expect(
      within(current).getByRole('button', { name: 'hr.trainings.extendFor' }),
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
    extensions: [] as never[],
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

describe('HR extends a training (AD-63 L2, NEW-35)', () => {
  const extension = (previousEndDate: string, newEndDate: string, reason: string) => ({
    previousEndDate,
    newEndDate,
    reason,
    extendedAt: '2026-11-05T10:00:00Z',
    extendedBy: 'HR One',
  });
  const training = (status: string, extensions: ReturnType<typeof extension>[] = []) => ({
    id: 's1',
    applicationId: 'app-s1',
    status,
    startDate: '2026-09-01',
    endDate: '2026-11-30',
    endReason: null as string | null,
    extensions,
    trainee: { id: 't1', fullName: 'Lina Haddad', email: 'lina@trainee.example' },
    employee: { id: 'e1', fullName: 'Mentor One', email: 'mentor@company.example' },
    fieldName: 'QA',
  });
  const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url, init]) => [url, JSON.parse(String(init!.body))]);

  async function openExtend() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'hr.trainings.extendFor' }));
    return { user, dialog: await screen.findByRole('dialog') };
  }
  const setDate = (dialog: HTMLElement, value: string) =>
    fireEvent.change(within(dialog).getByLabelText('hr.trainings.newEndDate'), {
      target: { value },
    });

  it('extends to a later date with a reason: shows the current date, reviews, confirms once', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'POST' ? [200, {}] : [200, [training('Active')]],
    );
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openExtend();

    const date = within(dialog).getByLabelText('hr.trainings.newEndDate');
    expect(date).toHaveAttribute('min', '2026-12-01'); // strictly later than the current end date
    setDate(dialog, '2027-01-31');
    await user.type(
      within(dialog).getByLabelText('hr.trainings.extensionReason'),
      '  Project not finished  ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('Project not finished')).toBeInTheDocument();
    await user.dblClick(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));

    await waitFor(() => expect(screen.getByText('hr.trainings.extended')).toBeInTheDocument());
    expect(posts(fetchMock)).toEqual([
      ['/api/hr/assignments/s1/extend', { endDate: '2027-01-31', reason: 'Project not finished' }],
    ]); // one submission only
  });

  it('requires a later date and a reason before review; the server refusal is shown in the form', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'POST'
        ? [400, { status: 400, code: 'assignment.extension_not_later' }]
        : [200, [training('Active')]],
    );
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openExtend();

    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('hr.trainings.errors.date')).toBeInTheDocument();
    expect(within(dialog).getByText('hr.trainings.errors.reason')).toBeInTheDocument();
    setDate(dialog, '2026-11-30'); // the same date: not later
    await user.type(within(dialog).getByLabelText('hr.trainings.extensionReason'), 'More work');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('hr.trainings.errors.notLater')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('hr.trainings.newEndDate')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(posts(fetchMock)).toEqual([]);

    setDate(dialog, '2026-12-15');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    expect(await within(dialog).findByText('hr.trainings.errors.notLater')).toBeInTheDocument();
  });

  it('a concurrent change (409) closes the dialog, says so and reloads', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'POST' ? [409, { status: 409 }] : [200, [training('Active')]],
    );
    renderPage(<TrainingsPage />);
    const { user, dialog } = await openExtend();
    setDate(dialog, '2027-01-31');
    await user.type(within(dialog).getByLabelText('hr.trainings.extensionReason'), 'More work');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    expect(await screen.findByText('training.errors.conflict')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === 'GET'),
      ).toHaveLength(2),
    );
  });

  it('lists every extension with its reason as plain text, also for a previous training; no Extend there', async () => {
    mockFetch(() => [
      200,
      [
        training('Completed', [
          extension('2026-10-31', '2026-11-15', 'First <b>reason</b>'),
          extension('2026-11-15', '2026-11-30', 'Second reason'),
        ]),
      ],
    ]);
    renderPage(<TrainingsPage />);
    const previous = await screen.findByRole('region', { name: 'hr.trainings.previous' });
    expect(
      within(previous).queryByRole('button', { name: 'hr.trainings.extendFor' }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(previous).getByRole('button', { name: 'hr.trainings.historyFor' }));
    const dialog = await screen.findByRole('dialog');
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('First <b>reason</b>')).toHaveAttribute('dir', 'auto');
    expect(dialog.querySelector('b')).toBeNull();
    expect(within(items[1]!).getByText('Second reason')).toBeInTheDocument();
  });

  it('a training without the extensions field (an older API) still renders, without a history button', async () => {
    const { extensions: _omitted, ...withoutField } = training('Completed');
    mockFetch(() => [200, [withoutField]]);
    renderPage(<TrainingsPage />);
    const previous = await screen.findByRole('region', { name: 'hr.trainings.previous' });
    expect(within(previous).getByText('Lina Haddad')).toBeInTheDocument();
    expect(within(previous).queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'تمديد تدريب Lina Haddad', 'تاريخ الانتهاء المخطط الجديد', 'سبب التمديد'],
    [
      'en',
      enMessages,
      'Extend the training of Lina Haddad',
      'New planned end date',
      'Extension reason',
    ],
  ] as const)('reads in %s', async (language, raw, button, dateLabel, reasonLabel) => {
    mockFetch(() => [200, [training('Active')]]);
    renderPage(<TrainingsPage />, { i18n: testI18n(JSON.parse(raw), language) });
    await userEvent.setup().click(await screen.findByRole('button', { name: button }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(dateLabel)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(reasonLabel)).toBeInTheDocument();
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

describe('HR transfers a training (AD-65)', () => {
  const hebronToday = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hebron' }).format(new Date());
  const shift = (date: string, days: number) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const today = hebronToday();
  const start = shift(today, -30);
  const end = shift(today, 30);
  const training = (overrides: object = {}) => ({
    id: 's1',
    applicationId: 'app-s1',
    status: 'Active',
    startDate: start,
    endDate: end,
    endReason: null as string | null,
    extensions: [] as never[],
    trainee: { id: 't1', fullName: 'Lina Haddad', email: 'lina@trainee.example' },
    employee: { id: 'e1', fullName: 'Mentor One', email: 'mentor@company.example' },
    fieldName: 'QA',
    canTransfer: true,
    transferredFrom: null,
    transferredTo: null,
    ...overrides,
  });
  const mentors = [
    { id: 'e1', fullName: 'Mentor One' },
    { id: 'e2', fullName: 'Mentor Two' },
  ];
  const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url, init]) => [url, JSON.parse(String(init!.body))]);

  function setup(post: [number, unknown?], rows: object[] = [training()]) {
    return mockFetch((method, url) => {
      if (url === '/api/hr/mentors') return [200, mentors];
      return method === 'POST' ? post : [200, rows];
    });
  }
  async function open() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'hr.trainings.transferFor' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('hr.trainings.newMentor');
    await waitFor(() => expect(select).toBeEnabled());
    return { user, dialog, select };
  }
  const setDate = (dialog: HTMLElement, value: string) =>
    fireEvent.change(within(dialog).getByLabelText('hr.trainings.transferDate'), {
      target: { value },
    });

  async function fill(
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    select: HTMLElement,
    date: string,
  ) {
    await user.selectOptions(select, 'e2');
    setDate(dialog, date);
    await user.type(within(dialog).getByLabelText('hr.trainings.transferReason'), ' New project ');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
  }
  const pendingDecision = {
    id: 'd1',
    status: 'Pending',
    effectiveDate: shift(today, 5),
    incomingEmployeeName: 'Mentor Two',
    reason: 'Plan',
    decidedBy: 'HR One',
    decidedAt: `${today}T08:00:00Z`,
    resolvedAt: null,
    resolvedBy: null,
    resolutionCode: null,
    resolutionReason: null,
  };

  it('today is an immediate transfer: current mentor excluded, no past dates, reviewed, confirmed once', async () => {
    const fetchMock = setup([200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog, select } = await open();

    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['hr.trainings.chooseMentor', 'Mentor Two']);
    const date = within(dialog).getByLabelText('hr.trainings.transferDate');
    expect(date).toHaveAttribute('min', today); // never in the past
    expect(date).toHaveAttribute('max', end); // not after the planned end date
    expect(within(dialog).getByText('hr.trainings.transferDateHint')).toBeInTheDocument();
    setDate(dialog, today);
    expect(within(dialog).getByText('hr.trainings.transferImmediate')).toBeInTheDocument();
    await fill(user, dialog, select, today);
    expect(within(dialog).getByText('Mentor Two')).toBeInTheDocument();
    expect(within(dialog).getByText('hr.trainings.typeImmediate')).toBeInTheDocument();
    expect(within(dialog).getByText('hr.trainings.currentMentorUntil')).toBeInTheDocument();
    await user.dblClick(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));

    await waitFor(() => expect(screen.getByText('hr.trainings.transferred')).toBeInTheDocument());
    expect(posts(fetchMock)).toEqual([
      [
        '/api/hr/assignments/s1/transfer',
        { employeeId: 'e2', transferDate: today, reason: 'New project' },
      ],
    ]);
  });

  it('a later date is a scheduled transfer: labelled as such and confirmed as scheduled', async () => {
    const fetchMock = setup([200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog, select } = await open();
    setDate(dialog, shift(today, 5));
    expect(within(dialog).getByText('hr.trainings.transferScheduledHint')).toBeInTheDocument();
    await fill(user, dialog, select, shift(today, 5));
    expect(within(dialog).getByText('hr.trainings.typeScheduled')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    await waitFor(() =>
      expect(screen.getByText('hr.trainings.transferScheduled')).toBeInTheDocument(),
    );
    expect(posts(fetchMock)).toEqual([
      [
        '/api/hr/assignments/s1/transfer',
        { employeeId: 'e2', transferDate: shift(today, 5), reason: 'New project' },
      ],
    ]);
  });

  it('requires a mentor, a valid date and a reason before review; past, first-day and late dates are refused', async () => {
    const fetchMock = setup([200, {}]);
    renderPage(<TrainingsPage />);
    const { user, dialog, select } = await open();
    const review = () =>
      user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));

    await review();
    for (const message of [
      'hr.trainings.errors.mentor',
      'hr.trainings.errors.date',
      'hr.trainings.errors.reason',
    ])
      expect(within(dialog).getByText(message)).toBeInTheDocument();
    await user.selectOptions(select, 'e2');
    await user.type(within(dialog).getByLabelText('hr.trainings.transferReason'), 'Moved');
    setDate(dialog, shift(today, -1));
    await review();
    expect(within(dialog).getByText('hr.trainings.errors.transferInPast')).toBeInTheDocument();
    setDate(dialog, shift(end, 1));
    await review();
    expect(within(dialog).getByText('hr.trainings.errors.transferAfterEnd')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('hr.trainings.transferDate')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(posts(fetchMock)).toEqual([]);
  });

  it('a training that starts later: the earliest date is the day after its start; its first day is refused', async () => {
    const later = shift(today, 3);
    setup([200, {}], [training({ startDate: later })]);
    renderPage(<TrainingsPage />);
    const { user, dialog, select } = await open();
    expect(within(dialog).getByLabelText('hr.trainings.transferDate')).toHaveAttribute(
      'min',
      shift(later, 1),
    );
    await user.selectOptions(select, 'e2');
    await user.type(within(dialog).getByLabelText('hr.trainings.transferReason'), 'Moved');
    setDate(dialog, later);
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(
      within(dialog).getByText('hr.trainings.errors.transferNotAfterStart'),
    ).toBeInTheDocument();
  });

  it.each([
    [403, 'assignment.transfer_not_responsible', 'hr.trainings.errors.transferNotResponsible'],
    [409, 'assignment.transfer_pending', 'hr.trainings.errors.transferPending'],
    [409, 'assignment.transfer_due', 'hr.trainings.errors.transferDue'],
    [409, undefined, 'training.errors.conflict'],
  ] as const)(
    'a %i (%s) refusal closes the dialog, says why and reloads',
    async (status, code, message) => {
      const fetchMock = setup([status, { status, code }]);
      renderPage(<TrainingsPage />);
      const { user, dialog, select } = await open();
      await fill(user, dialog, select, shift(today, 2));
      await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(
            ([url, init]) => url === '/api/hr/assignments' && (init?.method ?? 'GET') === 'GET',
          ),
        ).toHaveLength(2),
      );
    },
  );

  it('server refusals of the mentor or the date are shown on their fields', async () => {
    for (const [code, message] of [
      ['assignment.transfer_mentor_not_employee', 'hr.trainings.errors.mentorNotEmployee'],
      ['assignment.transfer_in_past', 'hr.trainings.errors.transferInPast'],
    ] as const) {
      setup([400, { status: 400, code }]);
      const view = renderPage(<TrainingsPage />);
      const { user, dialog, select } = await open();
      await fill(user, dialog, select, today);
      await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
      expect(await within(dialog).findByText(message)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('shows Transfer only where the server allows it, and the transfer links on both trainings', async () => {
    setup(
      [200, {}],
      [
        training({
          id: 's2',
          canTransfer: false,
          transferredFrom: { assignmentId: 's1', employeeName: 'Mentor One' },
        }),
        training({
          id: 's1',
          status: 'Transferred',
          canTransfer: false,
          endReason: 'Moved',
          transferredTo: { assignmentId: 's2', employeeName: 'Mentor Two' },
        }),
      ],
    );
    renderPage(<TrainingsPage />);
    expect(await screen.findByText('hr.trainings.transferredFrom')).toBeInTheDocument();
    expect(screen.getByText('hr.trainings.transferredTo')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'hr.trainings.transferFor' }),
    ).not.toBeInTheDocument();
  });

  it('a scheduled transfer is shown on the training; the responsible HR cancels it with a reason, once', async () => {
    const fetchMock = setup(
      [200, {}],
      [
        training({
          canTransfer: false,
          canCancelTransfer: true,
          transferDecisions: [pendingDecision],
        }),
      ],
    );
    renderPage(<TrainingsPage />);
    expect(await screen.findByText('hr.trainings.scheduledTransfer')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'hr.trainings.transferFor' }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'hr.trainings.cancelTransferFor' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'hr.trainings.confirmCancelTransfer' }),
    );
    expect(within(dialog).getByText('hr.trainings.errors.reason')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('hr.trainings.cancelReason')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(posts(fetchMock)).toEqual([]);
    await user.type(within(dialog).getByLabelText('hr.trainings.cancelReason'), ' Wrong mentor ');
    await user.dblClick(
      within(dialog).getByRole('button', { name: 'hr.trainings.confirmCancelTransfer' }),
    );
    await waitFor(() =>
      expect(screen.getByText('hr.trainings.transferCancelled')).toBeInTheDocument(),
    );
    expect(posts(fetchMock)).toEqual([
      ['/api/hr/transfer-decisions/d1/cancel', { reason: 'Wrong mentor' }],
    ]);
  });

  it.each([
    [403, 'assignment.transfer_not_responsible', 'hr.trainings.errors.transferNotResponsible'],
    [400, 'transfer_decision.invalid_status', 'hr.trainings.errors.transferNotPending'],
  ] as const)('a %i cancellation refusal says why and reloads', async (status, code, message) => {
    setup(
      [status, { status, code }],
      [
        training({
          canTransfer: false,
          canCancelTransfer: true,
          transferDecisions: [pendingDecision],
        }),
      ],
    );
    renderPage(<TrainingsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'hr.trainings.cancelTransferFor' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('hr.trainings.cancelReason'), 'x');
    await user.click(
      within(dialog).getByRole('button', { name: 'hr.trainings.confirmCancelTransfer' }),
    );
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('other HR users see the scheduled transfer but cannot cancel it', async () => {
    setup(
      [200, {}],
      [
        training({
          canTransfer: false,
          canCancelTransfer: false,
          transferDecisions: [pendingDecision],
        }),
      ],
    );
    renderPage(<TrainingsPage />);
    expect(await screen.findByText('hr.trainings.scheduledTransfer')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'hr.trainings.cancelTransferFor' }),
    ).not.toBeInTheDocument();
  });

  it('lists every transfer decision with its status: executed, cancelled (with the reason) and not carried out', async () => {
    const decided = { ...pendingDecision, resolvedAt: `${today}T09:00:00Z` };
    setup(
      [200, {}],
      [
        training({
          transferDecisions: [
            {
              ...decided,
              id: 'd1',
              status: 'Cancelled',
              resolvedBy: 'HR One',
              resolutionReason: 'Wrong mentor',
            },
            { ...decided, id: 'd2', status: 'Void', resolutionCode: 'mentor_not_employee' },
            { ...decided, id: 'd3', status: 'Executed' },
          ],
        }),
      ],
    );
    renderPage(<TrainingsPage />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'hr.trainings.transferDecisionsFor' }),
    );
    const dialog = await screen.findByRole('dialog');
    for (const text of [
      'hr.trainings.decisionStatus.Cancelled',
      'hr.trainings.decisionStatus.Void',
      'hr.trainings.decisionStatus.Executed',
      'hr.trainings.cancelledBy',
      'Wrong mentor',
      'hr.trainings.voidedOn',
      'hr.trainings.executedOn',
    ])
      expect(within(dialog).getByText(text)).toBeInTheDocument();
  });

  it('extending while a transfer takes effect today (409 transfer_due) says so and reloads', async () => {
    setup([409, { status: 409, code: 'assignment.transfer_due' }]);
    renderPage(<TrainingsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'hr.trainings.extendFor' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('hr.trainings.newEndDate'), {
      target: { value: shift(end, 10) },
    });
    await user.type(within(dialog).getByLabelText('hr.trainings.extensionReason'), 'More');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.confirm' }));
    expect(await screen.findByText('hr.trainings.errors.transferDue')).toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'نقل تدريب Lina Haddad', 'المدرّب الجديد', 'تاريخ النقل', 'سبب النقل'],
    [
      'en',
      enMessages,
      'Transfer the training of Lina Haddad',
      'New mentor',
      'Transfer date',
      'Transfer reason',
    ],
  ] as const)('reads in %s', async (language, raw, button, mentor, date, reason) => {
    setup([200, {}]);
    renderPage(<TrainingsPage />, { i18n: testI18n(JSON.parse(raw), language) });
    await userEvent.setup().click(await screen.findByRole('button', { name: button }));
    const dialog = await screen.findByRole('dialog');
    for (const label of [mentor, date, reason])
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
  });
});

describe('HR direct assignment (AD-67)', () => {
  const mentors = [
    { id: 'e1', fullName: 'Mentor One' },
    { id: 'e2', fullName: 'Mentor Two' },
  ];
  const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url, init]) => [url, JSON.parse(String(init!.body))]);
  function setup(post: [number, unknown?], canDirectAssign = true) {
    let assigned = false;
    const fetchMock = mockFetch(
      withLog((method, url) => {
        if (url === '/api/hr/mentors') return [200, mentors];
        if (method === 'POST') {
          if (post[0] < 300) assigned = true;
          return post;
        }
        return [200, { ...application('Accepted'), canDirectAssign: canDirectAssign && !assigned }];
      }),
    );
    return fetchMock;
  }
  async function open() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'hr.directAssign.actionFor' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('hr.directAssign.mentor');
    await waitFor(() => expect(select).toBeEnabled());
    return { user, dialog, select };
  }
  const setDate = (dialog: HTMLElement, label: string, value: string) =>
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

  it('is offered only where the server allows it (the responsible HR, accepted, never assigned)', async () => {
    setup([201, {}], false);
    page();
    expect(await screen.findByText('Lina Haddad')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'hr.directAssign.actionFor' }),
    ).not.toBeInTheDocument();
  });

  it('assigns after a review that warns about the pending requests; confirmed once; the page reloads', async () => {
    const fetchMock = setup([201, { assignment: {}, rejectedMentorRequests: 2 }]);
    page();
    const { user, dialog, select } = await open();
    expect(within(dialog).getByText('Backend')).toBeInTheDocument();
    await user.selectOptions(select, 'e2');
    setDate(dialog, 'hr.directAssign.startDate', '2027-02-01');
    setDate(dialog, 'hr.directAssign.endDate', '2027-04-30');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    expect(within(dialog).getByText('Mentor Two')).toBeInTheDocument();
    expect(within(dialog).getByText('hr.directAssign.pendingWarning')).toBeInTheDocument();
    await user.dblClick(within(dialog).getByRole('button', { name: 'hr.directAssign.confirm' }));
    expect(await screen.findByText('hr.directAssign.done')).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([
      [
        '/api/hr/applications/a1/direct-assignment',
        { employeeId: 'e2', startDate: '2027-02-01', endDate: '2027-04-30' },
      ],
    ]);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'hr.directAssign.actionFor' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('requires a mentor and a valid period before review; nothing is sent', async () => {
    const fetchMock = setup([201, {}]);
    page();
    const { user, dialog, select } = await open();
    const review = () =>
      user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await review();
    expect(within(dialog).getByText('hr.directAssign.errors.mentor')).toBeInTheDocument();
    expect(within(dialog).getByText('hr.directAssign.errors.dates')).toBeInTheDocument();
    await user.selectOptions(select, 'e1');
    setDate(dialog, 'hr.directAssign.startDate', '2027-05-01');
    setDate(dialog, 'hr.directAssign.endDate', '2027-04-30');
    await review();
    expect(within(dialog).getByText('hr.directAssign.errors.period')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('hr.directAssign.endDate')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(posts(fetchMock)).toEqual([]);
  });

  it.each([
    [403, 'direct_assignment.not_responsible', 'hr.directAssign.errors.notResponsible'],
    [409, 'direct_assignment.already_assigned', 'hr.directAssign.errors.alreadyAssigned'],
    [400, 'direct_assignment.not_accepted', 'hr.directAssign.errors.notAccepted'],
  ] as const)('a %i (%s) closes the dialog and says why', async (status, code, message) => {
    setup([status, { status, code }]);
    page();
    const { user, dialog, select } = await open();
    await user.selectOptions(select, 'e1');
    setDate(dialog, 'hr.directAssign.startDate', '2027-02-01');
    setDate(dialog, 'hr.directAssign.endDate', '2027-02-01');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.directAssign.confirm' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a mentor who is no longer an Employee is shown on the mentor field', async () => {
    setup([400, { status: 400, code: 'direct_assignment.mentor_not_employee' }]);
    page();
    const { user, dialog, select } = await open();
    await user.selectOptions(select, 'e1');
    setDate(dialog, 'hr.directAssign.startDate', '2027-02-01');
    setDate(dialog, 'hr.directAssign.endDate', '2027-03-01');
    await user.click(within(dialog).getByRole('button', { name: 'hr.trainings.review' }));
    await user.click(within(dialog).getByRole('button', { name: 'hr.directAssign.confirm' }));
    expect(
      await within(dialog).findByText('hr.directAssign.errors.mentorNotEmployee'),
    ).toBeInTheDocument();
  });

  it.each([
    [
      'ar',
      arMessages,
      'إسناد المتدرب Lina Haddad مباشرةً إلى مدرّب',
      'المدرّب',
      'تاريخ البداية',
      'تاريخ الانتهاء المخطط',
    ],
    [
      'en',
      enMessages,
      'Assign the trainee Lina Haddad directly to a mentor',
      'Mentor',
      'Start date',
      'Planned end date',
    ],
  ] as const)('reads in %s', async (language, raw, button, mentor, start, end) => {
    setup([201, {}]);
    renderRoutes([{ path: '/hr/applications/:id', element: <ApplicationDetailPage /> }], {
      url: '/hr/applications/a1',
      i18n: testI18n(JSON.parse(raw), language),
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: button }));
    const dialog = await screen.findByRole('dialog');
    for (const label of [mentor, start, end])
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
  });
});
