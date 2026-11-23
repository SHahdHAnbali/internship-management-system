import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import type { SessionUser } from '../../auth/models';
import { routes } from '../../routes';
import { fakeAuth, mockFetch, renderPage, renderRoutes, testI18n } from '../../test/render';
import { EmployeeArea } from '../employee/EmployeeArea';
import { HrArea } from '../hr/HrArea';
import { EvaluationPage } from './EvaluationPage';
import { EvaluationsPage } from './EvaluationsPage';

/**
 * Final evaluation (R27; AD-66, AD-68): the evaluators' Evaluations pages in the Employee and HR areas, never the Admin's
 * (S2.1), the shared draft (S2.2, AD-70) and the submission with its read-only result and verbal grade (S2.3, AD-71).
 * Never an average. Synthetic data.
 */
afterEach(() => vi.unstubAllGlobals());

const APP = '01a1eeee-0000-7000-8000-000000000001';
const item = (overrides: object = {}) => ({
  applicationId: APP,
  traineeName: 'Synthetic Trainee',
  fieldName: 'Synthetic Field',
  endStatus: 'EndedEarly',
  endDate: '2031-03-01',
  capacities: ['FinalMentor'],
  status: 'NotStarted',
  ...overrides,
});
const C1 = '01a1cccc-0000-7000-8000-000000000001';
const C2 = '01a1cccc-0000-7000-8000-000000000002';
const VERSION = `c1.${'A'.repeat(43)}`;
/** What a submitted evaluation carries for its evaluators (S2.3). */
const submission = (overrides: Record<string, unknown> = {}) => ({
  submittedAt: '2031-03-05T08:30:00Z',
  submittedBy: { name: 'Synthetic Mentor' },
  comment: 'Submitted comment',
  hiringRecommendation: 'Maybe',
  scores: { [C1]: 5, [C2]: 4 },
  grade: 'Excellent',
  ...overrides,
});
/** As the API returns it: a draft (S2.2, with the criteria fingerprint of S2.3) unless the evaluation is submitted. */
const detail = (overrides: Record<string, unknown> = {}) => {
  const value: Record<string, unknown> = {
    ...item(),
    startDate: '2031-01-01',
    commentOnly: false,
    criteria: [
      { id: C1, nameAr: 'التزام بالمواعيد', nameEn: 'Punctuality', sortOrder: 1 },
      { id: C2, nameAr: 'حضور وغياب', nameEn: 'Attendance and Absence', sortOrder: 3 },
    ],
    revision: 0,
    draft: { comment: null, hiringRecommendation: null, scores: {}, lastSavedAt: null },
    criteriaVersion: VERSION,
    ...overrides,
  };
  if (value.status === 'Submitted') {
    delete value.revision;
    delete value.draft;
    delete value.criteriaVersion;
    value.submission ??= submission(value.commentOnly ? { scores: {}, grade: null } : {});
  }
  return value;
};
const en = () => testI18n(JSON.parse(enMessages), 'en');
const ar = () => testI18n(JSON.parse(arMessages), 'ar');
const user = (role: SessionUser['role']): SessionUser => ({
  id: 'u1',
  role,
  email: 'u@company.example',
  name: null,
});

describe('EvaluationsPage', () => {
  it('lists the ended trainings with their end, the user’s capacity and the evaluation status, linking to each', async () => {
    const fetchMock = mockFetch(() => [
      200,
      [
        item(),
        item({
          applicationId: 'a2',
          traineeName: null,
          endStatus: 'Completed',
          capacities: ['FinalMentor', 'ResponsibleHr'],
          status: 'Submitted',
        }),
      ],
    ]);
    renderPage(<EvaluationsPage base="/hr/evaluations" />, { i18n: en() });

    const table = await screen.findByRole('table');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/evaluations',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Evaluations' })).toBeInTheDocument();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Trainee',
      'Training field',
      'Training ended',
      'End date',
      'Your role',
      'Evaluation',
      'Open',
    ]);
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(within(first!).getByText('Synthetic Trainee')).toBeInTheDocument();
    expect(within(first!).getByText('Ended early')).toBeInTheDocument();
    expect(within(first!).getByText('Final mentor')).toBeInTheDocument();
    expect(within(first!).getByText('Not started')).toHaveClass('ims-badge', 'whitespace-nowrap'); // UAT 2026-11-22: a status is one line, never a two-line pill
    expect(within(first!).getByRole('link', { name: 'Open: Synthetic Trainee' })).toHaveAttribute(
      'href',
      `/hr/evaluations/${APP}`,
    );
    expect(within(second!).getByText('Name not entered yet')).toBeInTheDocument();
    expect(within(second!).getByText('Final mentor, Responsible HR')).toBeInTheDocument();
    expect(within(second!).getByText('Submitted')).toBeInTheDocument();
    expect(within(second!).getByText('Completed')).toBeInTheDocument();
  });

  it('says when nothing is due, and shows a load error without details', async () => {
    mockFetch(() => [200, []]);
    const first = renderPage(<EvaluationsPage base="/employee/evaluations" />, { i18n: en() });
    expect(await screen.findByText('No final evaluation is due for you.')).toBeInTheDocument();
    first.unmount();

    mockFetch(() => [500, { detail: 'Stack trace' }]);
    renderPage(<EvaluationsPage base="/employee/evaluations" />, { i18n: en() });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the data.');
    expect(screen.queryByText(/Stack trace/)).not.toBeInTheDocument();
  });

  it('reads in Arabic', async () => {
    mockFetch(() => [200, [item({ status: 'Draft' })]]);
    renderPage(<EvaluationsPage base="/employee/evaluations" />, { i18n: ar() });
    expect(await screen.findByRole('heading', { level: 1, name: 'التقييمات' })).toBeInTheDocument();
    expect(screen.getByText('مسودة')).toBeInTheDocument();
    expect(screen.getByText('المرشد الأخير')).toBeInTheDocument();
  });
});

describe('EvaluationPage (read-only once submitted)', () => {
  const open = (body: unknown, status = 200, i18n = en()) => {
    const fetchMock = mockFetch(() => [status, body]);
    renderRoutes(
      [
        {
          path: '/employee/evaluations/:applicationId',
          element: <EvaluationPage base="/employee/evaluations" />,
        },
      ],
      { url: `/employee/evaluations/${APP}`, i18n },
    );
    return fetchMock;
  };

  it('shows the training and the criteria in order, each name in its own language and direction', async () => {
    const fetchMock = open(detail({ status: 'Submitted' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Synthetic Trainee' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/evaluations/${APP}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(screen.getByText('Submitted')).toHaveClass('ims-badge', 'whitespace-nowrap');
    expect(screen.getByText('Synthetic Field')).toBeInTheDocument();
    expect(screen.getByText('Final mentor')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Criteria' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const arabic = within(items[0]!).getByText('التزام بالمواعيد');
    expect([arabic.getAttribute('lang'), arabic.getAttribute('dir')]).toEqual(['ar', 'rtl']);
    const english = within(items[0]!).getByText('Punctuality');
    expect([english.getAttribute('lang'), english.getAttribute('dir')]).toEqual(['en', 'ltr']);
    expect(screen.getByRole('link', { name: 'Back to evaluations' })).toHaveAttribute(
      'href',
      '/employee/evaluations',
    );
  });

  it('a submitted evaluation is read-only: its frozen scores, comment, recommendation, submitter, time and grade, never an average', async () => {
    open(detail({ status: 'Submitted' }));
    const list = await screen.findByRole('list', { name: 'Criteria' });
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('spinbutton')).toEqual([]);
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryAllByRole('button')).toEqual([]);
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]!).getByText('5 of 5')).toBeInTheDocument();
    expect(within(items[1]!).getByText('4 of 5')).toBeInTheDocument();
    const value = (label: string) => screen.getByText(label).nextElementSibling;
    expect(value('Grade')).toHaveTextContent('Excellent');
    expect(value('Hiring recommendation')).toHaveTextContent('Maybe');
    expect(value('Submitted by')).toHaveTextContent('Synthetic Mentor');
    expect(value('Submitted on')).toHaveTextContent(
      new Date('2031-03-05T08:30:00Z').toLocaleString('en'),
    );
    expect(value('Comment')).toHaveTextContent('Submitted comment');
    expect(document.body.textContent).not.toMatch(/average|mean|4\.5/i);
  });

  it('explains a comment-only evaluation, before and after submission', async () => {
    open(detail({ commentOnly: true, criteria: [] }));
    expect(
      await screen.findByText(
        'There is no active criterion: this evaluation will consist of a written comment only.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Criteria' })).not.toBeInTheDocument();
  });

  it('marks the criteria of a submitted evaluation as frozen', async () => {
    open(detail({ status: 'Submitted' }));
    expect(
      await screen.findByText('The criteria as they were when the evaluation was submitted.'),
    ).toBeInTheDocument();
  });

  it('a comment-only submitted evaluation says so', async () => {
    open(detail({ status: 'Submitted', commentOnly: true, criteria: [] }));
    expect(
      await screen.findByText('This evaluation was submitted with a written comment only.'),
    ).toBeInTheDocument();
  });

  it('says "not found" for 404 (without saying why) and "not yet available" for 409', async () => {
    open({ status: 404, detail: 'The evaluation was not found.' }, 404);
    expect(await screen.findByRole('alert')).toHaveTextContent('This evaluation was not found.');
  });

  it('says when the evaluation is not available yet', async () => {
    open({ status: 409, code: 'evaluation.not_available' }, 409);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The final evaluation is available only after HR ends the training as Completed or Ended early.',
    );
  });

  it('reads in Arabic, with the Arabic names first', async () => {
    open(detail({ status: 'Submitted' }), 200, ar());
    expect(await screen.findByRole('list', { name: 'المعايير' })).toBeInTheDocument();
    expect(screen.getByText('فترة التدريب')).toBeInTheDocument();
  });
});

describe('Draft form (S2.2: shared draft, no submission)', () => {
  const saved = (overrides: Record<string, unknown> = {}) =>
    detail({
      status: 'Draft',
      revision: 1,
      draft: {
        comment: 'Saved comment',
        hiringRecommendation: 'Yes',
        scores: { [C1]: 4 },
        lastSavedAt: '2031-03-02T10:15:00Z',
      },
      ...overrides,
    });
  /** The page with `respond` answering every request: (method, url, body) → [status, body]. */
  const open = (respond: Parameters<typeof mockFetch>[0], i18n = en()) => {
    const fetchMock = mockFetch(respond);
    renderRoutes(
      [
        {
          path: '/hr/evaluations/:applicationId',
          element: <EvaluationPage base="/hr/evaluations" />,
        },
      ],
      { url: `/hr/evaluations/${APP}`, i18n },
    );
    return fetchMock;
  };
  const criterion = (name: string) => screen.getByRole('group', { name: new RegExp(name) });
  const puts = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls
      .filter((c) => c[1]?.method === 'PUT')
      .map((c) => [c[0], JSON.parse(String(c[1]!.body))]);

  it('shows the saved draft: scores selected, never-scored criteria unselected, no clear option, last-saved time only', async () => {
    open(() => [200, saved()]);
    const punctuality = await screen.findByRole('group', { name: /Punctuality/ });
    const radios = within(punctuality).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['1', '2', '3', '4', '5']); // no "none" or "clear"
    expect(within(punctuality).getByRole('radio', { name: '4' })).toBeChecked();
    expect(
      within(criterion('Attendance'))
        .getAllByRole('radio')
        .some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
    expect(screen.getByRole('textbox', { name: /Comment/ })).toHaveValue('Saved comment');
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeChecked();
    expect(screen.getByText(/^Last saved: /)).toHaveTextContent(
      new Date('2031-03-02T10:15:00Z').toLocaleString('en'),
    );
    expect(screen.getByRole('button', { name: 'Submit evaluation' })).toBeInTheDocument(); // S2.3
    expect(document.body.textContent).not.toMatch(/average|mean|grade|saved by/i);
    // Each name keeps its own language and direction.
    const arabic = within(punctuality).getByText('التزام بالمواعيد');
    expect([arabic.getAttribute('lang'), arabic.getAttribute('dir')]).toEqual(['ar', 'rtl']);
  });

  it('a draft not started has nothing selected and no last-saved time', async () => {
    open(() => [200, detail()]);
    await screen.findByRole('group', { name: /Punctuality/ });
    expect(
      screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked),
    ).toHaveLength(1); // recommendation: "Not chosen"
    expect(screen.getByRole('radio', { name: 'Not chosen' })).toBeChecked();
    expect(screen.queryByText(/Last saved/)).not.toBeInTheDocument();
  });

  it('saves the draft with its revision, shows "saved" and the new last-saved time, then saves on top of it', async () => {
    const user = userEvent.setup();
    let revision = 1;
    const fetchMock = open((method, _url, body) => {
      if (method !== 'PUT') return [200, saved()];
      const sent = body as {
        comment: string;
        hiringRecommendation: string;
        scores: Record<string, number>;
      };
      revision += 1;
      return [200, saved({ revision, draft: { ...sent, lastSavedAt: '2031-03-03T08:00:00Z' } })];
    });
    await screen.findByRole('group', { name: /Punctuality/ });

    await user.click(within(criterion('Attendance')).getByRole('radio', { name: '5' }));
    const comment = screen.getByRole('textbox', { name: /Comment/ });
    await user.clear(comment);
    await user.type(comment, 'Updated');
    await user.click(screen.getByRole('radio', { name: 'Maybe' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Draft saved')).toBeInTheDocument();
    expect(puts(fetchMock)).toEqual([
      [
        `/api/evaluations/${APP}/draft`,
        {
          revision: 1,
          comment: 'Updated',
          hiringRecommendation: 'Maybe',
          scores: { [C1]: 4, [C2]: 5 },
        },
      ],
    ]);
    expect(screen.getByText(/^Last saved: /)).toHaveTextContent(
      new Date('2031-03-03T08:00:00Z').toLocaleString('en'),
    );

    await user.click(within(criterion('Punctuality')).getByRole('radio', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(2));
    expect(puts(fetchMock)[1]![1]).toMatchObject({ revision: 2, scores: { [C1]: 2, [C2]: 5 } });
  });

  it('sends a blank comment and an unchosen recommendation as none; never-scored criteria are left out', async () => {
    const user = userEvent.setup();
    const fetchMock = open((method) => [200, method === 'PUT' ? saved({ revision: 2 }) : saved()]);
    await screen.findByRole('group', { name: /Punctuality/ });
    await user.clear(screen.getByRole('textbox', { name: /Comment/ }));
    await user.click(screen.getByRole('radio', { name: 'Not chosen' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(puts(fetchMock)[0]![1]).toEqual({
      revision: 1,
      comment: null,
      hiringRecommendation: null,
      scores: { [C1]: 4 },
    });
  });

  it('on a conflict keeps what was typed, and loads the latest version only after an explicit confirmation', async () => {
    const user = userEvent.setup();
    let gets = 0;
    const fetchMock = open((method) => {
      if (method === 'PUT') return [409, { status: 409, code: 'conflict.concurrent_update' }];
      gets += 1;
      return [
        200,
        gets === 1
          ? saved()
          : saved({
              revision: 3,
              draft: {
                comment: 'From the other evaluator',
                hiringRecommendation: 'No',
                scores: { [C1]: 1 },
                lastSavedAt: '2031-03-04T09:00:00Z',
              },
            }),
      ];
    });
    await screen.findByRole('group', { name: /Punctuality/ });
    const comment = screen.getByRole('textbox', { name: /Comment/ });
    await user.type(comment, ' and more');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another evaluator saved changes to this draft.',
    );
    expect(comment).toHaveValue('Saved comment and more');

    await user.click(screen.getByRole('button', { name: 'Load the latest version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: /Comment/ })).toHaveValue('Saved comment and more');
    expect(gets).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Load the latest version' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Discard and load the latest',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /Comment/ })).toHaveValue(
        'From the other evaluator',
      ),
    );
    expect(within(criterion('Punctuality')).getByRole('radio', { name: '1' })).toBeChecked();
    expect(fetchMock.mock.calls.filter((c) => (c[1]?.method ?? 'GET') === 'GET')).toHaveLength(2);
  });

  it.each([
    ['evaluation.criteria_changed', 'The evaluation criteria have changed.'],
    ['evaluation.already_submitted', 'This evaluation has already been submitted.'],
  ])('explains a %s refusal and offers the latest version', async (code, message) => {
    const user = userEvent.setup();
    open((method) => (method === 'PUT' ? [409, { status: 409, code }] : [200, saved()]));
    await screen.findByRole('group', { name: /Punctuality/ });
    await user.click(within(criterion('Attendance')).getByRole('radio', { name: '3' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Load the latest version' })).toBeInTheDocument();
  });

  it('shows an error when saving fails, without details, and keeps the input', async () => {
    const user = userEvent.setup();
    open((method) => (method === 'PUT' ? [500, { detail: 'Stack trace' }] : [200, saved()]));
    await screen.findByRole('group', { name: /Punctuality/ });
    await user.click(within(criterion('Attendance')).getByRole('radio', { name: '2' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The draft could not be saved. Try again.',
    );
    expect(screen.queryByText(/Stack trace/)).not.toBeInTheDocument();
    expect(within(criterion('Attendance')).getByRole('radio', { name: '2' })).toBeChecked();
  });

  it('refuses a comment over 4,000 characters next to the field and sends nothing', async () => {
    const fetchMock = open(() => [
      200,
      saved({
        draft: {
          comment: 'ع'.repeat(4001),
          hiringRecommendation: null,
          scores: {},
          lastSavedAt: null,
        },
      }),
    ]);
    const user = userEvent.setup();
    const comment = await screen.findByRole('textbox', { name: /Comment/ });
    expect(screen.getByText('4001 / 4000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(comment).toHaveAttribute('aria-invalid', 'true');
    expect(comment).toHaveAccessibleDescription(/at most 4000 characters/);
    expect(puts(fetchMock)).toEqual([]);
  });

  it('warns before leaving the page with unsaved changes only', async () => {
    const user = userEvent.setup();
    open(() => [200, saved()]);
    await screen.findByRole('group', { name: /Punctuality/ });
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await user.click(within(criterion('Attendance')).getByRole('radio', { name: '1' }));
    expect(leave()).toBe(true);
  });

  it('asks before an in-app navigation would lose unsaved changes: stay keeps them, leave goes (UAT 2026-11-22)', async () => {
    const user = userEvent.setup();
    mockFetch((_m, url) => (url.endsWith('/api/evaluations') ? [200, []] : [200, saved()]));
    renderRoutes(
      [
        {
          path: '/hr/evaluations/:applicationId',
          element: <EvaluationPage base="/hr/evaluations" />,
        },
        { path: '/hr/evaluations', element: <p>Evaluations list</p> },
      ],
      { url: `/hr/evaluations/${APP}`, i18n: en() },
    );
    await screen.findByRole('group', { name: /Punctuality/ });
    await user.click(within(criterion('Attendance')).getByRole('radio', { name: '3' }));

    await user.click(screen.getByRole('link', { name: 'Back to evaluations' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Stay on this page' }));
    expect(screen.queryByText('Evaluations list')).not.toBeInTheDocument();
    expect(within(criterion('Attendance')).getByRole('radio', { name: '3' })).toBeChecked();

    await user.click(screen.getByRole('link', { name: 'Back to evaluations' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Leave without saving',
      }),
    );
    expect(await screen.findByText('Evaluations list')).toBeInTheDocument();
  });

  it('does not ask before leaving when nothing is unsaved', async () => {
    const user = userEvent.setup();
    mockFetch(() => [200, saved()]);
    renderRoutes(
      [
        {
          path: '/hr/evaluations/:applicationId',
          element: <EvaluationPage base="/hr/evaluations" />,
        },
        { path: '/hr/evaluations', element: <p>Evaluations list</p> },
      ],
      { url: `/hr/evaluations/${APP}`, i18n: en() },
    );
    await screen.findByRole('group', { name: /Punctuality/ });
    await user.click(screen.getByRole('link', { name: 'Back to evaluations' }));
    expect(await screen.findByText('Evaluations list')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the comment and recommendation for a comment-only draft (no criterion)', async () => {
    open(() => [200, saved({ commentOnly: true, criteria: [] })]);
    expect(
      await screen.findByText(
        'There is no active criterion: this evaluation will consist of a written comment only.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Comment/ })).toBeInTheDocument();
    expect(screen.queryAllByRole('group', { name: /Punctuality/ })).toEqual([]);
  });

  it('reads in Arabic', async () => {
    open(() => [200, saved()], ar());
    expect(await screen.findByRole('button', { name: 'حفظ المسودة' })).toBeInTheDocument();
    expect(screen.getByText(/^آخر حفظ: /)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /التعليق/ })).toBeInTheDocument();
  });
});

describe('Submission (S2.3: submit the saved draft, read-only afterwards)', () => {
  const complete = (overrides: Record<string, unknown> = {}) =>
    detail({
      status: 'Draft',
      revision: 2,
      draft: {
        comment: 'Complete comment',
        hiringRecommendation: 'Yes',
        scores: { [C1]: 4, [C2]: 5 },
        lastSavedAt: '2031-03-02T10:15:00Z',
      },
      ...overrides,
    });
  const open = (respond: Parameters<typeof mockFetch>[0], i18n = en()) => {
    const fetchMock = mockFetch(respond);
    renderRoutes(
      [
        {
          path: '/employee/evaluations/:applicationId',
          element: <EvaluationPage base="/employee/evaluations" />,
        },
      ],
      { url: `/employee/evaluations/${APP}`, i18n },
    );
    return fetchMock;
  };
  const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls
      .filter((c) => c[1]?.method === 'POST')
      .map((c) => [c[0], JSON.parse(String(c[1]!.body))]);
  const gets = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls.filter((c) => (c[1]?.method ?? 'GET') === 'GET').length;

  it('submits the saved draft after an explicit confirmation, with its revision and criteria version, then shows it read-only', async () => {
    const user = userEvent.setup();
    const fetchMock = open((method) =>
      method === 'POST'
        ? [200, detail({ status: 'Submitted', submission: submission({ grade: 'VeryGood' }) })]
        : [200, complete()],
    );
    await user.click(await screen.findByRole('button', { name: 'Submit evaluation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Submit the evaluation?' });
    expect(dialog).toHaveTextContent(
      'After submission, you will not be able to edit this evaluation from this page.',
    );
    expect(posts(fetchMock)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Submit' }));

    expect(await screen.findByText('Very Good')).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([
      [`/api/evaluations/${APP}/submit`, { revision: 2, criteriaVersion: VERSION }],
    ]);
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Submit evaluation' })).not.toBeInTheDocument();
    expect(
      screen.getByText('This evaluation has been submitted and is read-only.'),
    ).toBeInTheDocument();
  });

  it('cancelling the confirmation sends nothing', async () => {
    const user = userEvent.setup();
    const fetchMock = open(() => [200, complete()]);
    await user.click(await screen.findByRole('button', { name: 'Submit evaluation' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(posts(fetchMock)).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('with unsaved changes asks to save first and sends nothing (no combined save and submit)', async () => {
    const user = userEvent.setup();
    const fetchMock = open(() => [200, complete()]);
    await user.type(await screen.findByRole('textbox', { name: /Comment/ }), ' edited');
    const button = screen.getByRole('button', { name: 'Submit evaluation' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Save your changes before submitting the evaluation.',
    );
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST' || c[1]?.method === 'PUT'),
    ).toEqual([]);
  });

  it('lists what the saved draft lacks: unscored criteria by name, the comment, the recommendation', async () => {
    const user = userEvent.setup();
    const fetchMock = open(() => [
      200,
      complete({
        draft: {
          comment: '  ',
          hiringRecommendation: null,
          scores: { [C1]: 3 },
          lastSavedAt: '2031-03-02T10:15:00Z',
        },
      }),
    ]);
    const button = await screen.findByRole('button', { name: 'Submit evaluation' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Before submitting, complete:');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['A score for: Attendance and Absence', 'The comment', 'The hiring recommendation']);
    expect(posts(fetchMock)).toEqual([]);
  });

  it('sends one submission only, however often it is confirmed while in progress; never retried', async () => {
    const user = userEvent.setup();
    let release: (value: [number, unknown]) => void = () => undefined;
    const pending = new Promise<[number, unknown]>((resolve) => (release = resolve));
    const fetchMock = mockFetch(() => [200, complete()]);
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const [status, payload] = await pending;
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(complete()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    renderRoutes(
      [
        {
          path: '/employee/evaluations/:applicationId',
          element: <EvaluationPage base="/employee/evaluations" />,
        },
      ],
      { url: `/employee/evaluations/${APP}`, i18n: en() },
    );
    await user.click(await screen.findByRole('button', { name: 'Submit evaluation' }));
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Submit',
    });
    await user.click(confirm);
    expect(
      await within(screen.getByRole('dialog')).findByRole('button', { name: 'Submitting…' }),
    ).toBeDisabled();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Submitting…' }),
    );
    release([500, { status: 500 }]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The submission could not be confirmed. Reload the evaluation to check its status before trying again.',
    );
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reload the evaluation' })).toBeInTheDocument();
  });

  it('a changed criteria set: its own dialog; Close keeps the page, “View the updated criteria” reloads them with the saved scores', async () => {
    const user = userEvent.setup();
    const C3 = '01a1cccc-0000-7000-8000-000000000003';
    let loads = 0;
    const fetchMock = open((method) => {
      if (method === 'POST') return [409, { status: 409, code: 'evaluation.criteria_changed' }];
      loads += 1;
      return [
        200,
        loads === 1
          ? complete()
          : complete({
              criteria: [
                { id: C1, nameAr: 'التزام بالمواعيد', nameEn: 'Punctuality', sortOrder: 1 },
                { id: C2, nameAr: 'حضور وغياب', nameEn: 'Attendance and Absence', sortOrder: 3 },
                { id: C3, nameAr: 'معيار جديد', nameEn: 'New criterion', sortOrder: 4 },
              ],
              criteriaVersion: `c1.${'B'.repeat(43)}`,
            }),
      ];
    });
    const submitAndRefuse = async () => {
      await user.click(await screen.findByRole('button', { name: 'Submit evaluation' }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Submit' }),
      );
      return screen.findByRole('dialog', { name: 'The evaluation criteria have been updated' });
    };
    let dialog = await submitAndRefuse();
    expect(dialog).toHaveTextContent('The evaluation was not submitted.');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gets(fetchMock)).toBe(1);

    dialog = await submitAndRefuse();
    await user.click(within(dialog).getByRole('button', { name: 'View the updated criteria' }));
    const added = await screen.findByRole('group', { name: /New criterion/ });
    expect(
      within(added)
        .getAllByRole('radio')
        .some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
    expect(
      within(screen.getByRole('group', { name: /Punctuality/ })).getByRole('radio', { name: '4' }),
    ).toBeChecked();
    expect(gets(fetchMock)).toBe(2);
    // Reviewing is required: the new criterion has no score, so a new submission lists it first.
    await user.click(screen.getByRole('button', { name: 'Submit evaluation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A score for: New criterion');
    expect(posts(fetchMock)).toHaveLength(2);
  });

  it.each([
    ['evaluation.incomplete', 'The evaluation is incomplete and was not submitted.'],
    [
      'conflict.concurrent_update',
      'Another evaluator saved changes to this draft. The evaluation was not submitted.',
    ],
    ['evaluation.already_submitted', 'This evaluation has already been submitted.'],
  ])('explains a %s refusal and offers to reload the evaluation', async (code, message) => {
    const user = userEvent.setup();
    let loads = 0;
    const fetchMock = open((method) => {
      if (method === 'POST') return [409, { status: 409, code }];
      loads += 1;
      return [200, complete()];
    });
    await user.click(await screen.findByRole('button', { name: 'Submit evaluation' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Submit' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await user.click(screen.getByRole('button', { name: 'Reload the evaluation' }));
    await waitFor(() => expect(loads).toBe(2));
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it('a comment-only submitted evaluation shows no grade', async () => {
    open(() => [200, detail({ status: 'Submitted', commentOnly: true, criteria: [] })]);
    expect((await screen.findByText('Grade')).nextElementSibling).toHaveTextContent(
      'No grade (an evaluation without criteria)',
    );
  });

  it('reads in Arabic: the approved wording and the five grades', async () => {
    const user = userEvent.setup();
    open(
      (method) =>
        method === 'POST'
          ? [409, { status: 409, code: 'evaluation.criteria_changed' }]
          : [200, complete()],
      ar(),
    );
    await user.click(await screen.findByRole('button', { name: 'تقديم التقييم' }));
    const confirm = await screen.findByRole('dialog', { name: 'تقديم التقييم؟' });
    expect(confirm).toHaveTextContent('بعد تقديم التقييم، لن تتمكن من تعديله من هذه الصفحة.');
    await user.click(within(confirm).getByRole('button', { name: 'تقديم' }));
    const changed = await screen.findByRole('dialog', { name: 'تم تحديث معايير التقييم' });
    expect(changed).toHaveTextContent(
      'طرأت تغييرات على معايير التقييم منذ فتح هذه الصفحة. لم يتم تقديم التقييم. يُرجى مراجعة المعايير المحدّثة قبل المحاولة مرة أخرى.',
    );
    expect(within(changed).getByRole('button', { name: 'إغلاق' })).toBeInTheDocument();
    expect(
      within(changed).getByRole('button', { name: 'عرض المعايير المحدّثة' }),
    ).toBeInTheDocument();
    const grades = JSON.parse(arMessages).evaluation.grades;
    expect(grades).toEqual({
      Excellent: 'ممتاز',
      VeryGood: 'جيد جدًا',
      Good: 'جيد',
      Pass: 'مقبول',
      Poor: 'ضعيف',
    });
  });

  it.each([
    ['Excellent', 'ممتاز'],
    ['VeryGood', 'جيد جدًا'],
    ['Good', 'جيد'],
    ['Pass', 'مقبول'],
    ['Poor', 'ضعيف'],
  ])('shows the %s grade in Arabic as %s', async (grade, label) => {
    open(() => [200, detail({ status: 'Submitted', submission: submission({ grade }) })], ar());
    await screen.findByRole('list', { name: 'المعايير' });
    expect(screen.getByText('التقدير').nextElementSibling).toHaveTextContent(label);
  });
});

describe('Post-UAT corrections (S2.3)', () => {
  const openSubmitted = (i18n = en()) => {
    mockFetch(() => [200, detail({ status: 'Submitted' })]);
    renderRoutes(
      [
        {
          path: '/employee/evaluations/:applicationId',
          element: <EvaluationPage base="/employee/evaluations" />,
        },
      ],
      { url: `/employee/evaluations/${APP}`, i18n },
    );
  };

  it('the Arabic evaluation texts say «تقديم» (submission), never «إرسال» (sending)', () => {
    const messages = JSON.parse(arMessages).evaluation;
    const texts: string[] = [];
    const walk = (node: unknown) =>
      typeof node === 'string' ? texts.push(node) : Object.values(node as object).forEach(walk);
    walk(messages);
    expect(texts.filter((x) => /إرسال|أُرسل|أرسل|مُرسَل|مرسل/.test(x))).toEqual([]);
    expect([
      messages.statuses.Submitted,
      messages.frozen,
      messages.commentOnlySubmitted,
      messages.readOnly,
      messages.draft.alreadySubmitted,
      messages.submit.alreadySubmitted,
    ]).toEqual([
      'مُقدَّم',
      'المعايير كما كانت عند تقديم التقييم.',
      'تم تقديم هذا التقييم بتعليق مكتوب فقط.',
      'تم تقديم هذا التقييم، وهو للقراءة فقط.',
      'تم تقديم هذا التقييم مسبقاً. ما أدخلته لم يُحفظ.',
      'تم تقديم هذا التقييم مسبقاً.',
    ]);
  });

  it('shows the submitted evaluation in Arabic with the «تقديم» wording', async () => {
    openSubmitted(ar());
    await screen.findByRole('list', { name: 'المعايير' });
    expect(screen.getByText('مُقدَّم')).toHaveClass('ims-badge');
    expect(screen.getByText('المعايير كما كانت عند تقديم التقييم.')).toBeInTheDocument();
    expect(screen.getByText('تم تقديم هذا التقييم، وهو للقراءة فقط.')).toBeInTheDocument();
  });

  it('each criterion’s names fill the row beside the score and start at the page’s start edge, in their own language', async () => {
    openSubmitted();
    const items = within(await screen.findByRole('list', { name: 'Criteria' })).getAllByRole(
      'listitem',
    );
    for (const item of items) {
      const [names, score] = [...item.children] as HTMLElement[];
      expect(names).toHaveClass('flex-1', 'min-w-0', 'flex-col', 'items-start');
      // Each line keeps the page's direction (no dir of its own); the name inside keeps its own language and direction.
      expect([...names!.children].map((line) => line.hasAttribute('dir'))).toEqual([false, false]);
      expect(
        [...names!.children].map((line) => [
          line.firstElementChild!.getAttribute('lang'),
          line.firstElementChild!.getAttribute('dir'),
        ]),
      ).toEqual([
        ['en', 'ltr'],
        ['ar', 'rtl'],
      ]);
      expect(score).toHaveTextContent(/of 5$/);
    }
  });
});

describe('Draft form criterion names (pre-commit correction)', () => {
  const LONG_EN =
    'Effective communication with the team, the stakeholders and the mentor throughout every phase of the project';
  const LONG_AR =
    'التواصل الفعّال مع الفريق والجهات المعنية والمرشد في جميع مراحل المشروع والتدريب العملي';
  const C3 = '01a1cccc-0000-7000-8000-000000000003';
  const draft = () =>
    detail({
      status: 'Draft',
      revision: 1,
      criteria: [
        { id: C1, nameAr: 'التزام بالمواعيد', nameEn: 'Punctuality', sortOrder: 1 },
        { id: C3, nameAr: LONG_AR, nameEn: LONG_EN, sortOrder: 2 },
      ],
      draft: {
        comment: 'Saved',
        hiringRecommendation: 'Yes',
        scores: { [C1]: 4 },
        lastSavedAt: '2031-03-02T10:15:00Z',
      },
    });
  const open = (respond: Parameters<typeof mockFetch>[0], i18n = en()) => {
    const fetchMock = mockFetch(respond);
    renderRoutes(
      [
        {
          path: '/hr/evaluations/:applicationId',
          element: <EvaluationPage base="/hr/evaluations" />,
        },
      ],
      { url: `/hr/evaluations/${APP}`, i18n },
    );
    return fetchMock;
  };
  /** Each legend line: [has its own dir, the name's lang, the name's dir, the name's text]. */
  const lines = (group: HTMLElement) => {
    const legend = group.querySelector('legend')!;
    expect(legend).toHaveClass('flex', 'flex-col', 'items-start');
    return [...legend.children].map((line) => [
      line.hasAttribute('dir'),
      line.firstElementChild!.getAttribute('lang'),
      line.firstElementChild!.getAttribute('dir'),
      line.textContent,
    ]);
  };

  it('in English: the English name, then the Arabic name, each line in the page’s direction, long names whole', async () => {
    open(() => [200, draft()]);
    expect(lines(await screen.findByRole('group', { name: /Punctuality/ }))).toEqual([
      [false, 'en', 'ltr', 'Punctuality'],
      [false, 'ar', 'rtl', 'التزام بالمواعيد'],
    ]);
    expect(lines(screen.getByRole('group', { name: /Effective communication/ }))).toEqual([
      [false, 'en', 'ltr', LONG_EN],
      [false, 'ar', 'rtl', LONG_AR],
    ]);
  });

  it('in Arabic: the Arabic name, then the English name, each line in the page’s direction', async () => {
    open(() => [200, draft()], ar());
    expect(lines(await screen.findByRole('group', { name: /التزام بالمواعيد/ }))).toEqual([
      [false, 'ar', 'rtl', 'التزام بالمواعيد'],
      [false, 'en', 'ltr', 'Punctuality'],
    ]);
    expect(lines(screen.getByRole('group', { name: new RegExp(LONG_AR) }))).toEqual([
      [false, 'ar', 'rtl', LONG_AR],
      [false, 'en', 'ltr', LONG_EN],
    ]);
  });

  it('scoring, the missing list and saving are unchanged for a long-named criterion', async () => {
    const user = userEvent.setup();
    const fetchMock = open((method, _url, body) =>
      method === 'PUT'
        ? [
            200,
            detail({
              ...draft(),
              revision: 2,
              draft: { ...(draft().draft as object), scores: (body as { scores: object }).scores },
            }),
          ]
        : [200, draft()],
    );
    const long = await screen.findByRole('group', { name: /Effective communication/ });
    await user.click(screen.getByRole('button', { name: 'Submit evaluation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`A score for: ${LONG_EN}`);
    await user.click(within(long).getByRole('radio', { name: '5' }));
    expect(within(long).getByRole('radio', { name: '5' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true),
    );
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]!.body)).scores).toEqual({ [C1]: 4, [C3]: 5 });
  });
});

describe('Evaluations navigation (Employee and HR only)', () => {
  const tabs = async () => {
    const nav = await screen.findByRole('navigation', { name: 'areas.navLabel' });
    return within(nav)
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')]);
  };

  it('the Employee and HR areas have an Evaluations tab', async () => {
    mockFetch(() => [200, { unreadCount: 0, hasMore: false, notifications: [] }]);
    const employee = renderRoutes([{ path: '/employee', element: <EmployeeArea /> }], {
      url: '/employee',
      auth: fakeAuth({ user: user('Employee') }),
    });
    expect(await tabs()).toContainEqual(['employee.nav.evaluations', '/employee/evaluations']);
    employee.unmount();

    renderRoutes([{ path: '/hr', element: <HrArea /> }], {
      url: '/hr',
      auth: fakeAuth({ user: user('HR') }),
    });
    expect(await tabs()).toContainEqual(['hr.nav.evaluations', '/hr/evaluations']);
  });

  it('the routes open the pages for Employee and HR; the Admin has no Evaluations page', async () => {
    mockFetch((_m, url) =>
      url.startsWith('/api/evaluations')
        ? [200, []]
        : [200, { unreadCount: 0, hasMore: false, notifications: [] }],
    );
    const employee = renderRoutes(routes, {
      url: '/employee/evaluations',
      auth: fakeAuth({ user: user('Employee') }),
    });
    expect(await screen.findByText('evaluation.empty')).toBeInTheDocument();
    employee.unmount();

    const hr = renderRoutes(routes, {
      url: '/hr/evaluations',
      auth: fakeAuth({ user: user('HR') }),
    });
    expect(await screen.findByText('evaluation.empty')).toBeInTheDocument();
    hr.unmount();

    // No route of the Admin area is an Evaluations page (the criteria page is `evaluation-criteria`).
    const paths = (list: typeof routes, prefix = ''): string[] =>
      list.flatMap((r) => {
        const path = r.path ? `${prefix}/${r.path}`.replace(/\/+/g, '/') : prefix;
        return [path, ...paths(r.children ?? [], path)];
      });
    const all = paths(routes);
    expect(all).toEqual(expect.arrayContaining(['/employee/evaluations', '/hr/evaluations']));
    expect(all.filter((p) => p.startsWith('/admin') && /\/evaluations(\/|$)/.test(p))).toEqual([]);
    expect(all.filter((p) => /\/evaluations(\/|$)/.test(p)).sort()).toEqual([
      '/employee/evaluations',
      '/employee/evaluations/:applicationId',
      '/hr/evaluations',
      '/hr/evaluations/:applicationId',
    ]);
  });
});
