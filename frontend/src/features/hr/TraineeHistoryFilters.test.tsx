import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import source from './TraineeHistoryReport.tsx?raw';
import { mockFetch, renderRoutes, testI18n } from '../../test/render';
import { TraineeHistoryReport } from './TraineeHistoryReport';

/**
 * The trainee history's filters (PDF §6 "filtered by period and field"): they narrow the trainings, through the API, and
 * never the contact notes.
 */
afterEach(() => vi.unstubAllGlobals());

const trainees = [
  { id: 't1', email: 'lina@trainee.example', fullName: 'Lina Haddad' }, // two trainings
  { id: 't-one', email: 'omar@trainee.example', fullName: 'Omar Saleh' }, // one training
  { id: 't-none', email: 'sara@trainee.example', fullName: 'Sara Khalil' }, // accepted, no training yet
];

const assignment = (id: string, mentor: string, start: string, end: string) => ({
  id,
  employeeName: mentor,
  status: 'Completed',
  startDate: start,
  endDate: end,
  endReason: null,
});
const note = (id: string, summary: string, date: string) => ({
  id,
  contactDate: date,
  method: 'Phone',
  summary,
  recordedAt: `${date}T10:00:00Z`,
  authorName: 'HR One',
});
const application = (
  id: string,
  fieldId: string,
  fieldName: string,
  assignments: ReturnType<typeof assignment>[],
  contactLogs: ReturnType<typeof note>[],
) => ({
  id,
  status: 'Accepted',
  fieldId,
  fieldName,
  availableFrom: '2031-01-01',
  availableTo: '2031-06-30',
  hours: 240,
  submittedAt: '2030-12-01T10:00:00Z',
  decidedAt: '2030-12-02T10:00:00Z',
  rejectionReason: null,
  assignments,
  contactLogs,
});

/**
 * The API's answer for trainee t1 (two trainings), t-one (one) or t-none (none): its filters narrow the assignments;
 * applications, contact notes and the total number of trainings are always all there.
 */
function historyFor(url: string) {
  const traineeId = /trainees\/([^/]+)\/history/.exec(url)![1]!;
  const query = new URLSearchParams(url.split('?')[1] ?? '');
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';
  const fieldId = query.get('fieldId') ?? '';
  const keep = (fid: string, s: ReturnType<typeof assignment>) =>
    (!fieldId || fid === fieldId) && (!from || s.endDate >= from) && (!to || s.startDate <= to);
  const qa =
    traineeId === 't-none' ? [] : [assignment('s1', 'Mentor One', '2031-01-01', '2031-01-31')];
  const backend =
    traineeId === 't1' ? [assignment('s2', 'Mentor Two', '2031-03-01', '2031-03-31')] : [];
  const trainee = trainees.find((t) => t.id === traineeId) ?? trainees[0]!;
  return {
    totalTrainings: qa.length + backend.length,
    trainee: { ...trainee, phone: null },
    applications: [
      application(
        'a1',
        'f-qa',
        'QA',
        qa.filter((s) => keep('f-qa', s)),
        [note('c1', 'First call.', '2030-12-01')],
      ),
      application(
        'a2',
        'f-be',
        'Backend',
        backend.filter((s) => keep('f-be', s)),
        [note('c2', 'Second call.', '2031-02-15')],
      ),
    ],
  };
}

function api(history: (url: string) => [number, unknown?] = (url) => [200, historyFor(url)]) {
  return mockFetch((_method, url) => (url === '/api/hr/trainees' ? [200, trainees] : history(url)));
}

const historyCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/history'));

function open(url = '/hr/reports/trainee-history?trainee=t1', i18n = testI18n(null, 'en')) {
  return renderRoutes(
    [{ path: '/hr/reports/trainee-history', element: <TraineeHistoryReport /> }],
    { url, i18n },
  );
}

const trainingMentors = () =>
  within(screen.getByRole('region', { name: 'hr.reports.traineeHistory.trainings' }))
    .queryAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[1]!.textContent);
const noteSummaries = () =>
  within(screen.getByRole('region', { name: 'hr.reports.traineeHistory.contactNotes' }))
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[2]!.textContent);

describe('trainee history filters', () => {
  it('shows every training without filters, then narrows the trainings only by period and field', async () => {
    const fetchMock = api();
    const { router } = open();
    const user = userEvent.setup();

    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One', 'Mentor Two']));
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']);
    expect(historyCalls(fetchMock)).toEqual(['/api/hr/trainees/t1/history']);

    // The field choices are the trainee's own application fields.
    const field = screen.getByLabelText('training.fields.field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['', 'f-qa', 'f-be']);

    // Field.
    await user.selectOptions(field, 'f-be');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor Two']));
    expect(historyCalls(fetchMock).at(-1)).toBe('/api/hr/trainees/t1/history?fieldId=f-be');
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']); // contact notes untouched
    expect(within(field).getAllByRole('option')).toHaveLength(3); // choices stay

    // Field and period together: the period overlaps nothing in Backend.
    const from = screen.getByLabelText('hr.reports.traineeHistory.from');
    const to = screen.getByLabelText('hr.reports.traineeHistory.to');
    await user.type(from, '2031-01-15');
    await user.type(to, '2031-02-28');
    await waitFor(() =>
      expect(historyCalls(fetchMock).at(-1)).toBe(
        '/api/hr/trainees/t1/history?from=2031-01-15&to=2031-02-28&fieldId=f-be',
      ),
    );
    expect(
      await screen.findByText('hr.reports.traineeHistory.noMatchingTrainings'),
    ).toBeInTheDocument();
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']);

    // Period only.
    await user.selectOptions(field, '');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    expect(historyCalls(fetchMock).at(-1)).toBe(
      '/api/hr/trainees/t1/history?from=2031-01-15&to=2031-02-28',
    );
    expect(router.state.location.search).toBe('?trainee=t1&from=2031-01-15&to=2031-02-28');
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']);
  });

  it('opens with the filters given in the address', async () => {
    const fetchMock = api();
    open('/hr/reports/trainee-history?trainee=t1&from=2031-03-31&field=f-be');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor Two']));
    expect(historyCalls(fetchMock)).toEqual([
      '/api/hr/trainees/t1/history?from=2031-03-31&fieldId=f-be',
    ]);
    expect(screen.getByLabelText('hr.reports.traineeHistory.from')).toHaveValue('2031-03-31');
    expect(screen.getByLabelText('training.fields.field')).toHaveValue('f-be');
  });

  it('flags a period ending before it starts and does not apply that end; ignores malformed dates', async () => {
    const fetchMock = api();
    open('/hr/reports/trainee-history?trainee=t1&from=2031-03-01&to=2031-02-01');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor Two']));
    expect(historyCalls(fetchMock)).toEqual(['/api/hr/trainees/t1/history?from=2031-03-01']);
    const to = screen.getByLabelText('hr.reports.traineeHistory.to');
    expect(to).toHaveAttribute('aria-invalid', 'true');
    expect(to).toHaveAccessibleDescription('hr.reports.traineeHistory.periodInvalid');

    const second = api();
    open('/hr/reports/trainee-history?trainee=t1&from=yesterday&to=2031-13');
    await waitFor(() => expect(historyCalls(second)).toEqual(['/api/hr/trainees/t1/history']));
  });

  it('choosing another trainee starts without filters', async () => {
    mockFetch((_m, url) =>
      url === '/api/hr/trainees'
        ? [200, [...trainees, { id: 't2', email: 'omar@trainee.example', fullName: 'Omar' }]]
        : [200, historyFor(url)],
    );
    const { router } = open('/hr/reports/trainee-history?trainee=t1&field=f-qa&from=2031-01-01');
    const user = userEvent.setup();
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    await user.selectOptions(screen.getByLabelText('hr.reports.traineeHistory.trainee'), 't2');
    await waitFor(() => expect(router.state.location.search).toBe('?trainee=t2'));
  });

  it('shows the not-in-report and error states as before, with filters too', async () => {
    api(() => [404, { status: 404 }]);
    const first = open('/hr/reports/trainee-history?trainee=t9&field=f-qa');
    expect(await screen.findByText('hr.reports.traineeHistory.notFound')).toBeInTheDocument();
    first.unmount();

    api(() => [500, { detail: 'Stack trace' }]);
    open('/hr/reports/trainee-history?trainee=t1&from=2031-01-01');
    expect(await screen.findByText('training.errors.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(/Stack trace/)).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'الفترة من', 'كل المجالات', 'لا يوجد تدريب لهذا المتدرب يطابق هذه التصفية.'],
    [
      'en',
      enMessages,
      'Period from',
      'All fields',
      'No training of this trainee matches these filters.',
    ],
  ] as const)('reads in %s', async (language, raw, fromLabel, allFields, noMatch) => {
    api();
    open(
      '/hr/reports/trainee-history?trainee=t1&from=2031-02-01&to=2031-02-28',
      testI18n(JSON.parse(raw), language),
    );
    expect(await screen.findByLabelText(fromLabel)).toHaveValue('2031-02-01');
    expect(screen.getByRole('option', { name: allFields })).toBeInTheDocument();
    expect(await screen.findByText(noMatch)).toBeInTheDocument();
  });

  it('lays out with logical (RTL/LTR-neutral) classes only', () => {
    expect(source).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
  });
});

describe('trainee history filters: shown only from two trainings on', () => {
  const filterInputs = () => [
    screen.queryByLabelText('hr.reports.traineeHistory.from'),
    screen.queryByLabelText('hr.reports.traineeHistory.to'),
    screen.queryByLabelText('training.fields.field'),
  ];
  const filtersShown = () => filterInputs().every(Boolean);
  const filtersHidden = () =>
    filterInputs().every((input) => input === null) &&
    screen.queryByRole('search', { name: 'hr.reports.traineeHistory.filters' }) === null;

  it('hides the filters when the trainee has no training, showing the empty state', async () => {
    api();
    open('/hr/reports/trainee-history?trainee=t-none');
    expect(await screen.findByText('hr.reports.traineeHistory.noTrainings')).toBeInTheDocument();
    expect(filtersHidden()).toBe(true);
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']);
  });

  it('hides the filters when the trainee has exactly one training, showing it', async () => {
    api();
    open('/hr/reports/trainee-history?trainee=t-one');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    expect(filtersHidden()).toBe(true);
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']);
  });

  it('shows the filters, empty, from two trainings on, and keeps them when filtering down to one or none', async () => {
    api();
    open();
    const user = userEvent.setup();
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One', 'Mentor Two']));
    expect(filtersShown()).toBe(true);
    expect(screen.getByLabelText('hr.reports.traineeHistory.from')).toHaveValue('');
    expect(screen.getByLabelText('hr.reports.traineeHistory.to')).toHaveValue('');
    expect(screen.getByLabelText('training.fields.field')).toHaveValue('');

    // Down to one training: the filters stay.
    await user.selectOptions(screen.getByLabelText('training.fields.field'), 'f-qa');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    expect(filtersShown()).toBe(true);

    // Down to none: the filters stay, with the no-match message.
    await user.type(screen.getByLabelText('hr.reports.traineeHistory.from'), '2031-06-01');
    expect(
      await screen.findByText('hr.reports.traineeHistory.noMatchingTrainings'),
    ).toBeInTheDocument();
    expect(filtersShown()).toBe(true);
    expect(noteSummaries()).toEqual(['Second call.', 'First call.']); // never filtered
  });

  it('switching trainees resets the filters: dropped for one training, empty for several', async () => {
    const fetchMock = api();
    const { router } = open('/hr/reports/trainee-history?trainee=t1&field=f-qa&from=2031-01-01');
    const user = userEvent.setup();
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    const trainee = screen.getByLabelText('hr.reports.traineeHistory.trainee');

    await user.selectOptions(trainee, 't-one');
    await waitFor(() => expect(router.state.location.search).toBe('?trainee=t-one'));
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    expect(filtersHidden()).toBe(true);
    expect(historyCalls(fetchMock).at(-1)).toBe('/api/hr/trainees/t-one/history');

    await user.selectOptions(trainee, 't1');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One', 'Mentor Two']));
    expect(filtersShown()).toBe(true);
    expect(screen.getByLabelText('training.fields.field')).toHaveValue('');
    expect(screen.getByLabelText('hr.reports.traineeHistory.from')).toHaveValue('');
    expect(historyCalls(fetchMock).at(-1)).toBe('/api/hr/trainees/t1/history');
  });

  it('drops filters given in the address for a trainee with fewer than two trainings, asking for all', async () => {
    const fetchMock = api();
    const { router } = open('/hr/reports/trainee-history?trainee=t-one&from=2031-06-01&field=f-be');
    // The filtered answer would be empty; the filters are removed and every training is shown.
    await waitFor(() => expect(router.state.location.search).toBe('?trainee=t-one'));
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    expect(historyCalls(fetchMock).at(-1)).toBe('/api/hr/trainees/t-one/history');
    expect(router.state.historyAction).toBe('REPLACE'); // Back does not return to the dropped filters
    expect(filtersHidden()).toBe(true);
    expect(
      screen.queryByText('hr.reports.traineeHistory.noMatchingTrainings'),
    ).not.toBeInTheDocument();
  });

  it('follows the address on Back and Forward', async () => {
    const fetchMock = api();
    const { router } = open('/hr/reports/trainee-history?trainee=t1');
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One', 'Mentor Two']));

    await act(() => router.navigate('/hr/reports/trainee-history?trainee=t1&field=f-be'));
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor Two']));
    expect(screen.getByLabelText('training.fields.field')).toHaveValue('f-be');

    await act(() => router.navigate('/hr/reports/trainee-history?trainee=t-one'));
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One']));
    expect(filtersHidden()).toBe(true);

    await act(() => router.navigate(-1)); // Back: Lina, filtered by Backend
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor Two']));
    expect(filtersShown()).toBe(true);
    expect(screen.getByLabelText('training.fields.field')).toHaveValue('f-be');

    await act(() => router.navigate(-1)); // Back: Lina, no filter
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor One', 'Mentor Two']));
    expect(screen.getByLabelText('training.fields.field')).toHaveValue('');

    await act(() => router.navigate(1)); // Forward: filtered again
    await waitFor(() => expect(trainingMentors()).toEqual(['Mentor Two']));
    expect(historyCalls(fetchMock)).toContain('/api/hr/trainees/t1/history?fieldId=f-be');
  });

  it.each([
    ['ar', arMessages, 'الفترة من', 'لا يوجد تدريب مسجّل لهذا المتدرب.'],
    ['en', enMessages, 'Period from', 'No training recorded for this trainee.'],
  ] as const)('reads in %s, with and without filters', async (language, raw, fromLabel, none) => {
    const i18n = testI18n(JSON.parse(raw), language);
    api();
    const first = open('/hr/reports/trainee-history?trainee=t1', i18n);
    expect(await screen.findByLabelText(fromLabel)).toBeInTheDocument();
    first.unmount();

    open('/hr/reports/trainee-history?trainee=t-none', i18n);
    expect(await screen.findByText(none)).toBeInTheDocument();
    expect(screen.queryByLabelText(fromLabel)).not.toBeInTheDocument();
  });
});
