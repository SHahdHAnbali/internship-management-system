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
 * Final evaluation, stage S2.1 (R27; AD-66, AD-68): the evaluators' read-only Evaluations pages in the Employee and HR
 * areas, never the Admin's. No editing, no submission, no score, comment, recommendation or average. Synthetic data.
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
/** As the API returns it: a draft (S2.2) unless the evaluation is submitted. */
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
    ...overrides,
  };
  if (value.status === 'Submitted') {
    delete value.revision;
    delete value.draft;
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

  it('a submitted evaluation is read-only: no field, no button, no score, comment, recommendation or average', async () => {
    open(detail({ status: 'Submitted' }));
    await screen.findByRole('list', { name: 'Criteria' });
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('spinbutton')).toEqual([]);
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/score|average|mean|grade|recommend|comment:/i);
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
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
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
