import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { TraineeHistoryReport } from '../../features/hr/TraineeHistoryReport';
import { mockFetch, renderRoutes, testI18n } from '../../test/render';
import { FieldsReport } from '../FieldsReport';
import { MentorProfileReport } from '../MentorProfileReport';
import { MonthlyReport } from '../MonthlyReport';
import type { ExportDocument } from './model';

/**
 * Exporting the four reports from their pages: what each one hands to the exporter is exactly what the page shows
 * (same columns, rows and filters), built from the data already loaded; exporting fetches nothing. The files themselves
 * are tested in export.test.ts. Synthetic data only.
 */
const files = vi.hoisted(() => ({
  exportFile: vi.fn(async (_doc: unknown, _format: string): Promise<Blob> => new Blob(['file'])),
  saveFile: vi.fn((_blob: Blob, _fileName: string): void => undefined),
}));
vi.mock('./files', async (original) => ({
  ...(await original<typeof import('./files')>()),
  ...files,
}));

beforeEach(() => {
  files.exportFile.mockClear();
  files.saveFile.mockClear();
  files.exportFile.mockImplementation(async () => new Blob(['file']));
});
afterEach(() => vi.unstubAllGlobals());

const en = () => testI18n(null, 'en');
const lastDocument = () => files.exportFile.mock.calls.at(-1)![0] as ExportDocument;
const lastFormat = () => files.exportFile.mock.calls.at(-1)![1] as string;
const savedName = () => files.saveFile.mock.calls.at(-1)![1] as string;
const tableRows = (table = screen.getByRole('table')) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));

async function exportAs(format: 'xlsx' | 'pdf') {
  await userEvent.setup().click(screen.getByRole('button', { name: `reports.export.${format}` }));
  await waitFor(() => expect(files.saveFile).toHaveBeenCalled());
}

describe('monthly report export (HR and Admin)', () => {
  const filters = {
    fields: [{ id: 'f-qa', name: 'QA' }],
    employees: [{ id: 'e-1', fullName: 'Mentor One' }],
  };
  const report = (rows: unknown[]) => ({
    month: '2031-02',
    monthStart: '2031-02-01',
    monthEnd: '2031-02-28',
    rows,
  });
  const row = {
    assignmentId: 's1',
    traineeName: 'Synthetic Trainee',
    employee: { id: 'e-1', fullName: 'Mentor One' },
    field: { id: 'f-qa', name: 'QA' },
    startDate: '2031-01-10',
    endDate: '2031-02-14',
  };
  const open = (area: 'hr' | 'admin', answer: (url: string) => [number, unknown?], i18n = en()) => {
    const fetchMock = mockFetch((_m, url) =>
      url.includes('/filters') ? [200, filters] : answer(url),
    );
    renderRoutes(
      [
        {
          path: `/${area}/reports/monthly`,
          element: <MonthlyReport area={area} backTo={`/${area}/reports`} />,
        },
      ],
      { url: `/${area}/reports/monthly?month=2031-02&field=f-qa&employee=e-1`, i18n },
    );
    return fetchMock;
  };

  it.each(['hr', 'admin'] as const)(
    '%s: exports exactly the shown rows, with the month and filters, without fetching',
    async (area) => {
      const fetchMock = open(area, () => [200, report([row])]);
      await screen.findByRole('table');
      await waitFor(() =>
        expect(screen.getByLabelText('reports.monthly.employee')).toHaveValue('e-1'),
      );
      const calls = fetchMock.mock.calls.length;

      await exportAs('xlsx');
      const doc = lastDocument();
      expect(lastFormat()).toBe('xlsx');
      expect(savedName()).toBe('ims-monthly-report-2031-02.xlsx');
      expect(doc.sections[0]!.columns.map((c) => c.label)).toEqual([
        'reports.monthly.trainee',
        'reports.monthly.employee',
        'reports.monthly.field',
        'reports.monthly.from',
        'reports.monthly.to',
      ]);
      expect(doc.sections[0]!.rows).toEqual(tableRows());
      expect(doc.details).toEqual([
        expect.stringContaining('February 2031'),
        'reports.monthly.field: QA',
        'reports.monthly.employee: Mentor One',
      ]);
      expect(fetchMock.mock.calls.length).toBe(calls); // nothing new was fetched

      await exportAs('pdf');
      expect(lastFormat()).toBe('pdf');
      expect(savedName()).toBe('ims-monthly-report-2031-02.pdf');
    },
  );

  it('exports an empty month with the page’s empty message', async () => {
    open('hr', () => [200, report([])]);
    await screen.findByText('reports.monthly.empty');
    await exportAs('xlsx');
    expect(lastDocument().sections[0]).toMatchObject({ rows: [], empty: 'reports.monthly.empty' });
  });

  it('cannot export while the report is loading or failed', async () => {
    open('hr', () => [500]);
    expect(await screen.findByRole('alert')).toHaveTextContent('reports.monthly.loadFailed');
    const button = screen.getByRole('button', { name: 'reports.export.xlsx' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.setup().click(button);
    expect(files.exportFile).not.toHaveBeenCalled();
  });

  it('says so when the file cannot be prepared', async () => {
    files.exportFile.mockImplementation(async () => {
      throw new Error('font missing');
    });
    open('hr', () => [200, report([row])]);
    await screen.findByRole('table');
    await userEvent.setup().click(screen.getByRole('button', { name: 'reports.export.pdf' }));
    expect(await screen.findByText('reports.export.failed')).toBeInTheDocument();
    expect(files.saveFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/font missing/)).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'التقرير الشهري', 'rtl', 'تصدير Excel', 'المتدرب'],
    ['en', enMessages, 'Monthly report', 'ltr', 'Export Excel', 'Trainee'],
  ] as const)(
    'exports in %s, with the page’s own labels and direction',
    async (language, raw, title, direction, button, trainee) => {
      open('hr', () => [200, report([row])], testI18n(JSON.parse(raw), language));
      await screen.findByRole('table');
      await userEvent.setup().click(screen.getByRole('button', { name: button }));
      await waitFor(() => expect(files.saveFile).toHaveBeenCalled());
      const doc = lastDocument();
      expect(doc).toMatchObject({ title, direction, language });
      expect(doc.sections[0]!.columns[0]!.label).toBe(trainee);
    },
  );
});

describe('fields report export (HR and Admin)', () => {
  const rows = [
    { field: { id: 'f-be', name: 'Backend' }, applications: 5, accepted: 2 },
    { field: { id: 'f-qa', name: 'QA' }, applications: 1, accepted: 0 },
  ];

  it.each(['hr', 'admin'] as const)(
    '%s: exports the counts as numbers, the field filter and the note on completion',
    async (area) => {
      mockFetch((_m, url) => [200, { rows: url.includes('fieldId=f-qa') ? [rows[1]] : rows }]);
      renderRoutes(
        [
          {
            path: `/${area}/reports/fields`,
            element: <FieldsReport area={area} backTo={`/${area}/reports`} />,
          },
        ],
        { url: `/${area}/reports/fields?field=f-qa`, i18n: en() },
      );
      await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
      await exportAs('xlsx');
      const doc = lastDocument();
      expect(doc.sections[0]!.rows).toEqual([['QA', 1, 0]]);
      expect(doc.sections[0]!.columns.map((c) => Boolean(c.numeric))).toEqual([false, true, true]);
      expect(doc.details).toEqual(['reports.fields.field: QA', 'reports.fields.completedNotShown']);
      expect(savedName()).toMatch(/^ims-fields-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
      expect(JSON.stringify(doc)).not.toMatch(/complet(ed)?":\s*\d/); // no invented completed count
    },
  );
});

describe('mentor profile export', () => {
  const mentor = (id: string, fullName: string, trainees: number, assignments: number) => ({
    employee: { id, fullName },
    trainees,
    assignments,
  });

  it('HR: every employee, as shown', async () => {
    const fetchMock = mockFetch(() => [
      200,
      { rows: [mentor('e1', 'Mentor One', 4, 5), mentor('e2', 'Mentor Two', 0, 0)] },
    ]);
    renderRoutes(
      [
        {
          path: '/hr/reports/mentor-profile',
          element: <MentorProfileReport scope="all" backTo="/hr/reports" />,
        },
      ],
      { url: '/hr/reports/mentor-profile', i18n: en() },
    );
    await screen.findByRole('table');
    await exportAs('pdf');
    expect(lastDocument().sections[0]!.rows).toEqual([
      ['Mentor One', 4, 5],
      ['Mentor Two', 0, 0],
    ]);
    expect(lastDocument().details[0]).toBe(
      'reports.mentorProfile.employee: reports.mentorProfile.allEmployees',
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/hr/reports/mentor-profile',
    ]);
  });

  it('HR with an employee chosen: Excel and PDF hold only that row, and say which employee; clearing restores everyone', async () => {
    const everyone = [mentor('e1', 'Mentor One', 4, 5), mentor('e2', 'Mentor Two', 0, 0)];
    const fetchMock = mockFetch((_method, url) => {
      const chosen = /employeeId=(.+)$/.exec(url)?.[1];
      return [200, { rows: chosen ? everyone.filter((r) => r.employee.id === chosen) : everyone }];
    });
    renderRoutes(
      [
        {
          path: '/hr/reports/mentor-profile',
          element: <MentorProfileReport scope="all" backTo="/hr/reports" />,
        },
      ],
      { url: '/hr/reports/mentor-profile', i18n: en() },
    );
    await screen.findByRole('table');
    const user = userEvent.setup();
    const selector = screen.getByRole('combobox', { name: 'reports.mentorProfile.employee' });

    await user.selectOptions(selector, 'e1');
    await waitFor(() => expect(tableRows()).toEqual([['Mentor One', '4', '5']]));
    const calls = fetchMock.mock.calls.length;
    for (const format of ['xlsx', 'pdf'] as const) {
      await exportAs(format);
      expect(lastFormat()).toBe(format);
      expect(lastDocument().sections[0]!.rows).toEqual([['Mentor One', 4, 5]]);
      expect(lastDocument().details[0]).toBe('reports.mentorProfile.employee: Mentor One');
      expect(savedName()).toMatch(new RegExp(`^ims-mentor-profile-.*\\.${format}$`));
    }
    expect(fetchMock.mock.calls.length).toBe(calls); // exporting fetches nothing

    await user.selectOptions(selector, '');
    await waitFor(() => expect(tableRows()).toHaveLength(2));
    await exportAs('xlsx');
    expect(lastDocument().sections[0]!.rows).toEqual([
      ['Mentor One', 4, 5],
      ['Mentor Two', 0, 0],
    ]);
    expect(lastDocument().details[0]).toBe(
      'reports.mentorProfile.employee: reports.mentorProfile.allEmployees',
    );
  });

  describe.each([
    ['en', enMessages, 'No employees yet.', 'No matching employees.', 'All employees'],
    ['ar', arMessages, 'لا يوجد موظفون بعد.', 'لا يوجد موظفون مطابقون.', 'كل الموظفين'],
  ] as const)('HR empty exports in %s', (language, raw, none, noMatch, all) => {
    const i18n = () => testI18n(JSON.parse(raw), language);
    const messages = JSON.parse(raw);
    const employeeLabel = messages.reports.mentorProfile.employee as string;
    /** As `exportAs`, with the buttons' translated names. */
    const exportIn = async (format: 'xlsx' | 'pdf') => {
      files.saveFile.mockClear();
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: messages.reports.export[format] as string }));
      await waitFor(() => expect(files.saveFile).toHaveBeenCalled());
    };
    const openAt = (query: string) =>
      renderRoutes(
        [
          {
            path: '/hr/reports/mentor-profile',
            element: <MentorProfileReport scope="all" backTo="/hr/reports" />,
          },
        ],
        { url: `/hr/reports/mentor-profile${query}`, i18n: i18n() },
      );

    it.each(['xlsx', 'pdf'] as const)(
      '%s: no employees at all says so, for All employees',
      async (format) => {
        mockFetch(() => [200, { rows: [] }]);
        openAt('');
        await screen.findByText(none);
        await exportIn(format);
        expect(lastFormat()).toBe(format);
        expect(lastDocument().sections[0]).toMatchObject({ rows: [], empty: none });
        expect(lastDocument().details[0]).toBe(`${employeeLabel}: ${all}`);
      },
    );

    it.each(['xlsx', 'pdf'] as const)(
      '%s: no row for the chosen employee says no matching employees, as the page',
      async (format) => {
        mockFetch((_method, url) => [
          200,
          { rows: url.includes('employeeId=') ? [] : [mentor('e1', 'Mentor One', 4, 5)] },
        ]);
        openAt('?employee=e404');
        await screen.findByText(noMatch);
        await exportIn(format);
        expect(lastFormat()).toBe(format);
        expect(lastDocument().sections[0]).toMatchObject({ rows: [], empty: noMatch });
        expect(lastDocument().details[0]).toBe(`${employeeLabel}: —`); // unknown id, as the selector
      },
    );

    it.each(['xlsx', 'pdf'] as const)(
      '%s: a matching employee exports their row',
      async (format) => {
        mockFetch((_method, url) => [
          200,
          {
            rows: url.includes('employeeId=e1')
              ? [mentor('e1', 'Mentor One', 4, 5)]
              : [mentor('e1', 'Mentor One', 4, 5), mentor('e2', 'Mentor Two', 0, 0)],
          },
        ]);
        openAt('?employee=e1');
        await waitFor(() => expect(tableRows()).toEqual([['Mentor One', '4', '5']]));
        await exportIn(format);
        expect(lastDocument().sections[0]!.rows).toEqual([['Mentor One', 4, 5]]);
        expect(lastDocument().details[0]).toBe(`${employeeLabel}: Mentor One`);
      },
    );
  });

  it('Employee: only their own row, from their own endpoint', async () => {
    const fetchMock = mockFetch(() => [200, mentor('e9', 'My Own Name', 2, 3)]);
    renderRoutes(
      [
        {
          path: '/employee/reports/mentor-profile',
          element: <MentorProfileReport scope="own" backTo="/employee/reports" />,
        },
      ],
      { url: '/employee/reports/mentor-profile', i18n: en() },
    );
    await screen.findByText('My Own Name');
    await exportAs('xlsx');
    expect(lastDocument().sections[0]!.rows).toEqual([['My Own Name', 2, 3]]);
    expect(savedName()).toMatch(/^ims-my-mentor-profile-/);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/employee/reports/mentor-profile',
    ]);
  });
});

describe('trainee history export (HR)', () => {
  const trainees = [
    { id: 't1', email: 'synthetic@trainee.example', fullName: 'Synthetic Trainee' },
  ];
  const application = (
    id: string,
    fieldId: string,
    fieldName: string,
    assignments: unknown[],
    contactLogs: unknown[],
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
  const assignment = (id: string, mentor: string, start: string, end: string) => ({
    id,
    employeeName: mentor,
    status: 'Completed',
    startDate: start,
    endDate: end,
    endReason: null,
  });
  const note = (id: string, summary: string) => ({
    id,
    contactDate: '2031-02-15',
    method: 'Phone',
    summary,
    recordedAt: '2031-02-15T10:00:00Z',
    authorName: 'HR Person',
  });

  it('exports the trainings as filtered and every contact note, with the filters in use, and no contact details', async () => {
    const fetchMock = mockFetch((_m, url) => {
      if (url === '/api/hr/trainees') return [200, trainees];
      const onlyBackend = url.includes('fieldId=f-be');
      return [
        200,
        {
          totalTrainings: 2,
          trainee: {
            id: 't1',
            email: 'synthetic@trainee.example',
            fullName: 'Synthetic Trainee',
            phone: '+000-SYNTHETIC',
          },
          applications: [
            application(
              'a1',
              'f-qa',
              'QA',
              onlyBackend ? [] : [assignment('s1', 'Mentor One', '2031-01-01', '2031-01-31')],
              [note('c1', 'First call.')],
            ),
            application(
              'a2',
              'f-be',
              'Backend',
              [assignment('s2', 'Mentor Two', '2031-03-01', '2031-03-31')],
              [note('c2', 'Second call.')],
            ),
          ],
        },
      ];
    });
    renderRoutes([{ path: '/hr/reports/trainee-history', element: <TraineeHistoryReport /> }], {
      url: '/hr/reports/trainee-history?trainee=t1&field=f-be',
      i18n: en(),
    });
    const trainings = await screen.findByRole('region', {
      name: 'hr.reports.traineeHistory.trainings',
    });
    await waitFor(() => expect(within(trainings).getAllByRole('row')).toHaveLength(2));
    const calls = fetchMock.mock.calls.length;

    await exportAs('xlsx');
    const doc = lastDocument();
    const [shownTrainings, shownNotes] = doc.sections;
    expect(shownTrainings!.rows).toEqual(tableRows(within(trainings).getByRole('table')));
    expect(shownTrainings!.rows).toHaveLength(1);
    // Every contact note, as the page shows them (never filtered).
    const notesTable = within(
      screen.getByRole('region', { name: 'hr.reports.traineeHistory.contactNotes' }),
    ).getByRole('table');
    expect(shownNotes!.rows).toEqual(tableRows(notesTable));
    expect(shownNotes!.rows.map((r) => r[2]).sort()).toEqual(['First call.', 'Second call.']);
    expect(doc.details).toEqual(
      expect.arrayContaining([
        'hr.reports.traineeHistory.trainee: Synthetic Trainee',
        'training.fields.field: Backend',
      ]),
    );
    expect(savedName()).toMatch(/^ims-trainee-history-Synthetic-Trainee-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('synthetic@trainee.example');
    expect(text).not.toContain('+000-SYNTHETIC');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
