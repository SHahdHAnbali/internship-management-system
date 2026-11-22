import { screen, within } from '@testing-library/react';
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
const detail = (overrides: object = {}) => ({
  ...item(),
  startDate: '2031-01-01',
  commentOnly: false,
  criteria: [
    { id: 'c1', nameAr: 'التزام بالمواعيد', nameEn: 'Punctuality', sortOrder: 1 },
    { id: 'c2', nameAr: 'حضور وغياب', nameEn: 'Attendance and Absence', sortOrder: 3 },
  ],
  ...overrides,
});
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

describe('EvaluationPage (read-only)', () => {
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
    const fetchMock = open(detail());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Synthetic Trainee' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/evaluations/${APP}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(screen.getByText('Not started')).toHaveClass('ims-badge', 'whitespace-nowrap');
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

  it('is read-only: no field, no button, no score, comment, recommendation or average', async () => {
    open(detail({ status: 'Draft' }));
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
    open(detail(), 200, ar());
    expect(await screen.findByRole('list', { name: 'المعايير' })).toBeInTheDocument();
    expect(screen.getByText('فترة التدريب')).toBeInTheDocument();
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
