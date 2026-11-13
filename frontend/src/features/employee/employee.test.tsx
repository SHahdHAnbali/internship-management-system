import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { mockFetch, renderPage, testI18n } from '../../test/render';
import { AvailableTraineesPage } from './AvailableTraineesPage';
import { MyTraineesPage } from './MyTraineesPage';

afterEach(() => vi.unstubAllGlobals());

const lina = {
  applicationId: 'a1',
  trainee: {
    fullName: 'Lina Haddad',
    university: 'Example University',
    major: 'Computer Engineering',
    studyYear: 'Fourth year',
  },
  field: { id: 'f1', name: 'Backend' },
  availableFrom: '2027-02-01',
  availableTo: '2027-04-30',
  hours: 240,
  mandatoryForUniversity: true,
  hasCv: true,
};

describe('available trainees', () => {
  it('loads the list from the API and filters by field, university and period', async () => {
    const fetchMock = mockFetch((_m, url) =>
      url === '/api/employee/fields' ? [200, [{ id: 'f1', name: 'Backend' }]] : [200, [lina]],
    );
    renderPage(<AvailableTraineesPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('Lina Haddad')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('training.fields.field'), 'f1');
    await user.type(screen.getByLabelText('training.profile.university'), 'Example');
    await user.type(screen.getByLabelText('employee.available.from'), '2027-03-01');
    await user.type(screen.getByLabelText('employee.available.to'), '2027-03-31');
    await user.click(screen.getByRole('button', { name: 'employee.available.search' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/employee/available-trainees?fieldId=f1&university=Example&from=2027-03-01&to=2027-03-31',
        expect.anything(),
      ),
    );
  });

  it('"I Want to Train" needs a short note and sends it for this trainee; the request then waits for HR', async () => {
    const fetchMock = mockFetch((method, url) => {
      if (method === 'POST') return [201, { id: 'r1', status: 'Pending' }];
      return url === '/api/employee/fields' ? [200, []] : [200, [lina]];
    });
    renderPage(<AvailableTraineesPage />);
    const user = userEvent.setup();
    const row = (await screen.findByText('Lina Haddad')).closest('tr')!;

    await user.click(within(row).getByRole('button', { name: 'employee.available.wantToTrain' }));
    await user.click(screen.getByRole('button', { name: 'employee.request.send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('employee.request.noteRequired');
    expect(screen.getByLabelText('employee.request.note')).toHaveAttribute('aria-invalid', 'true');

    await user.type(screen.getByLabelText('employee.request.note'), 'Build the reporting API');
    await user.click(screen.getByRole('button', { name: 'employee.request.send' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/employee/mentor-requests',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ applicationId: 'a1', note: 'Build the reporting API' }),
        }),
      ),
    );
    expect(await screen.findByText('employee.request.sent')).toBeInTheDocument();
  });

  it('opens the CV only through a temporary link from the API', async () => {
    const fetchMock = mockFetch((method, url) => {
      if (method === 'POST')
        return [200, { url: '/api/files?token=cv', expiresAt: '2027-01-01T00:00:00Z' }];
      return url === '/api/employee/fields' ? [200, []] : [200, [lina]];
    });
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    renderPage(<AvailableTraineesPage />);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: 'employee.available.viewCv: Lina Haddad' }),
    );
    await waitFor(() => expect(tab.location.href).toBe('/api/files?token=cv'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/employee/applications/a1/cv-link',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('my trainees', () => {
  const assignment = (id: string, status: string, name: string) => ({
    id,
    applicationId: `app-${id}`,
    status,
    startDate: '2027-02-03',
    endDate: '2027-04-28',
    trainee: { fullName: name, university: 'Example University', major: 'CE' },
    fieldName: 'Backend',
  });

  it('separates current and previous trainees, shows requests waiting for HR, and records notes', async () => {
    const fetchMock = mockFetch((method, url) => {
      if (url === '/api/employee/mentor-requests')
        return [
          200,
          [
            {
              id: 'r1',
              applicationId: 'app-r1',
              status: 'Pending',
              note: 'Data work',
              requestedAt: '2026-10-29T10:00:00Z',
              decidedAt: null,
              traineeName: 'Omar',
              fieldName: 'QA',
            },
          ],
        ];
      if (url === '/api/employee/trainees')
        return [
          200,
          [
            assignment('s1', 'Active', 'Lina Haddad'),
            assignment('s0', 'Completed', 'Sara Example'),
          ],
        ];
      if (method === 'POST')
        return [201, { id: 'n2', writtenAt: '2027-02-10T10:00:00Z', text: 'Second week done' }];
      return [
        200,
        [
          {
            id: 'n1',
            writtenAt: '2027-02-05T10:00:00Z',
            text: 'Onboarding done',
            authorName: 'Me',
          },
        ],
      ];
    });
    renderPage(<MyTraineesPage />);
    const user = userEvent.setup();

    const current = await screen.findByRole('region', { name: 'employee.trainees.current' });
    expect(within(current).getByText('Lina Haddad')).toBeInTheDocument();
    expect(within(current).queryByText('Sara Example')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'employee.trainees.previous' })).getByText(
        'Sara Example',
      ),
    ).toBeInTheDocument();
    const requests = screen.getByRole('region', { name: 'employee.trainees.requests' });
    expect(within(requests).getByText('training.requestStatus.Pending')).toBeInTheDocument();
    expect(await within(current).findByText('Onboarding done')).toBeInTheDocument();
    // The CV stays reachable for one's own requested and assigned trainees (current and previous).
    expect(
      within(current).getByRole('button', { name: 'employee.available.viewCv: Lina Haddad' }),
    ).toBeInTheDocument();
    expect(
      within(requests).getByRole('button', { name: 'employee.available.viewCv: Omar' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'employee.trainees.previous' })).getByRole(
        'button',
        {
          name: 'employee.available.viewCv: Sara Example',
        },
      ),
    ).toBeInTheDocument();

    await user.click(within(current).getByRole('button', { name: 'employee.notes.add' }));
    expect(within(current).getByRole('alert')).toHaveTextContent('employee.notes.required');
    await user.type(within(current).getByLabelText('employee.notes.new'), 'Second week done');
    await user.click(within(current).getByRole('button', { name: 'employee.notes.add' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/employee/assignments/s1/notes',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Second week done' }),
        }),
      ),
    );
  });
});

describe('progress notes of a current trainee', () => {
  const current = {
    id: 's1',
    applicationId: 'app-s1',
    status: 'Active',
    startDate: '2027-02-03',
    endDate: '2027-04-28',
    trainee: { fullName: 'Lina Haddad', university: 'Example University', major: 'CE' },
    fieldName: 'Backend',
  };

  /** The page with one current trainee; `notes` answers the notes request. */
  function notesApi(notes: (method: string) => [number, unknown?]) {
    return mockFetch((method, url) => {
      if (url === '/api/employee/mentor-requests') return [200, []];
      if (url === '/api/employee/trainees') return [200, [current]];
      return notes(method);
    });
  }

  const currentSection = () => screen.findByRole('region', { name: 'employee.trainees.current' });

  it('lists the loaded notes with their author', async () => {
    notesApi(() => [
      200,
      [{ id: 'n1', writtenAt: '2027-02-05T10:00:00Z', text: 'Onboarding done', authorName: 'Me' }],
    ]);
    renderPage(<MyTraineesPage />);
    const section = await currentSection();
    expect(await within(section).findByText('Onboarding done')).toBeInTheDocument();
    expect(within(section).getByText(/^Me · /)).toBeInTheDocument();
    expect(within(section).queryByText('employee.notes.empty')).not.toBeInTheDocument();
    expect(within(section).queryByText('employee.notes.loadFailed')).not.toBeInTheDocument();
  });

  it('says there are no notes yet when the list is empty', async () => {
    notesApi(() => [200, []]);
    renderPage(<MyTraineesPage />);
    const section = await currentSection();
    expect(await within(section).findByText('employee.notes.empty')).toBeInTheDocument();
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([401, 403, 500])(
    'shows a load error, not an empty list, when the request fails (%i)',
    async (status) => {
      notesApi(() => [status, { status, code: 'internal.code', detail: 'Stack trace here' }]);
      renderPage(<MyTraineesPage />);
      const section = await currentSection();
      expect(await within(section).findByRole('alert')).toHaveTextContent(
        'employee.notes.loadFailed',
      );
      expect(within(section).queryByText('employee.notes.empty')).not.toBeInTheDocument();
      expect(section).not.toHaveTextContent(String(status));
      expect(section).not.toHaveTextContent(/internal\.code|Stack trace/);
    },
  );

  it('shows a load error when the server cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/employee/mentor-requests') return Response.json([]);
        if (url === '/api/employee/trainees') return Response.json([current]);
        throw new TypeError('Failed to fetch');
      }),
    );
    renderPage(<MyTraineesPage />);
    const section = await currentSection();
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'employee.notes.loadFailed',
    );
    expect(section).not.toHaveTextContent('Failed to fetch');
  });

  it.each([
    ['ar', arMessages, 'rtl', 'تعذّر تحميل الملاحظات. يرجى المحاولة مرة أخرى.'],
    ['en', enMessages, 'ltr', 'Unable to load notes. Please try again.'],
  ] as const)('the load error reads in %s', async (language, raw, dir, message) => {
    notesApi(() => [500]);
    const i18n = testI18n(JSON.parse(raw), language);
    expect(i18n.dir).toBe(dir);
    renderPage(<MyTraineesPage />, { i18n });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('still lets the employee write a note, and shows it once saved', async () => {
    let saved = false;
    const fetchMock = notesApi((method) => {
      if (method === 'POST') {
        saved = true;
        return [201, { id: 'n2', writtenAt: '2027-02-10T10:00:00Z', text: 'Second week done' }];
      }
      return [
        200,
        saved
          ? [
              {
                id: 'n2',
                writtenAt: '2027-02-10T10:00:00Z',
                text: 'Second week done',
                authorName: 'Me',
              },
            ]
          : [],
      ];
    });
    renderPage(<MyTraineesPage />);
    const user = userEvent.setup();
    const section = await currentSection();
    await within(section).findByText('employee.notes.empty');

    await user.click(within(section).getByRole('button', { name: 'employee.notes.add' }));
    expect(within(section).getByRole('alert')).toHaveTextContent('employee.notes.required');
    expect(within(section).getByLabelText('employee.notes.new')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

    await user.type(within(section).getByLabelText('employee.notes.new'), 'Second week done');
    await user.click(within(section).getByRole('button', { name: 'employee.notes.add' }));
    expect(await within(section).findByText('Second week done')).toBeInTheDocument();
    expect(within(section).queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/employee/assignments/s1/notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Second week done' }),
      }),
    );
  });

  it('on the day a scheduled transfer takes effect (409 transfer_due) the note is refused and kept in the box', async () => {
    notesApi((method) =>
      method === 'POST' ? [409, { status: 409, code: 'assignment.transfer_due' }] : [200, []],
    );
    renderPage(<MyTraineesPage />);
    const user = userEvent.setup();
    const section = await currentSection();
    await within(section).findByText('employee.notes.empty');
    await user.type(within(section).getByLabelText('employee.notes.new'), 'Day one');
    await user.click(within(section).getByRole('button', { name: 'employee.notes.add' }));
    expect(await screen.findByText('employee.notes.transferDue')).toBeInTheDocument();
    expect(within(section).getByLabelText('employee.notes.new')).toHaveValue('Day one');
  });
});

describe('earlier mentors’ notes after a transfer (AD-65)', () => {
  const mine = (id: string, status: string, canReadEarlierNotes: boolean) => ({
    id,
    applicationId: 'app-1',
    status,
    startDate: '2027-02-10',
    endDate: '2027-04-28',
    trainee: { fullName: 'Lina Haddad', university: 'Example University', major: 'CE' },
    fieldName: 'Backend',
    canReadEarlierNotes,
  });
  const earlier = [
    {
      id: 'n1',
      writtenAt: '2027-02-01T09:00:00Z',
      text: 'Earlier <b>note</b>',
      authorName: 'Mentor A',
      assignment: { startDate: '2027-01-03', endDate: '2027-02-09', mentorName: 'Mentor A' },
    },
  ];

  function setup(trainees: object[]) {
    return mockFetch((_method, url) => {
      if (url === '/api/employee/mentor-requests') return [200, []];
      if (url === '/api/employee/trainees') return [200, trainees];
      if (url.endsWith('/earlier-notes')) return [200, earlier];
      if (url.endsWith('/notes')) return [200, []];
      return [404];
    });
  }

  it('the latest mentor opens the earlier notes, read-only, as plain text with the earlier mentor and period', async () => {
    const fetchMock = setup([mine('s2', 'Active', true)]);
    renderPage(<MyTraineesPage />);
    const toggle = await screen.findByRole('button', { name: 'employee.notes.earlierTitle' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/earlier-notes'))).toBe(
      false,
    ); // on demand
    await userEvent.setup().click(toggle);
    expect(await screen.findByText('Earlier <b>note</b>')).toHaveAttribute('dir', 'auto');
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText('employee.notes.earlierContext')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/employee/assignments/s2/earlier-notes',
      expect.anything(),
    );
    // Read-only: no form or button for the earlier notes besides the toggle; one note form (the current training).
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('also after the training ended; never for an assignment that was transferred onward', async () => {
    setup([mine('s2', 'Completed', true), mine('s1', 'Transferred', false)]);
    renderPage(<MyTraineesPage />);
    expect(
      await screen.findAllByRole('button', { name: 'employee.notes.earlierTitle' }),
    ).toHaveLength(1);
  });

  it.each([
    ['ar', arMessages, 'ملاحظات المدرّبين السابقين'],
    ['en', enMessages, 'Earlier mentors’ notes'],
  ] as const)('reads in %s', async (language, raw, label) => {
    setup([mine('s2', 'Active', true)]);
    renderPage(<MyTraineesPage />, { i18n: testI18n(JSON.parse(raw), language) });
    expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
  });
});
