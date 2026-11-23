import { render, screen, waitFor, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { AuthContext } from '../../auth/context';
import { RequireRole } from '../../auth/guards';
import type { SessionUser } from '../../auth/models';
import { ToastProvider } from '../../components/Toast';
import { I18nContext } from '../../i18n/context';
import { routes } from '../../routes';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from '../../test/render';
import { CorrectionPage } from './CorrectionPage';
import { EvaluationPage } from './EvaluationPage';

/**
 * Correcting a submitted final evaluation (R27 stage S2.4; owner decisions of 2026-11-23, AD-72): a separate page
 * prefilled with the current values, a confirmation, one request, back to the read-only page; the latest correction's
 * metadata only on the read-only page. Synthetic data.
 */
afterEach(() => vi.unstubAllGlobals());

const APP = '01a1eeee-0000-7000-8000-000000000001';
const C1 = '01a1cccc-0000-7000-8000-000000000001';
const C2 = '01a1cccc-0000-7000-8000-000000000002';
const CRITERIA = [
  { id: C1, nameAr: 'التزام بالمواعيد', nameEn: 'Punctuality', sortOrder: 1 },
  { id: C2, nameAr: 'حضور وغياب', nameEn: 'Attendance and Absence', sortOrder: 3 },
];
const summary = {
  applicationId: APP,
  traineeName: 'Synthetic Trainee',
  fieldName: 'Synthetic Field',
  endStatus: 'EndedEarly',
  endDate: '2031-03-01',
  capacities: ['FinalMentor'],
  startDate: '2031-01-01',
};
const start = (overrides: Record<string, unknown> = {}) => ({
  ...summary,
  status: 'Submitted',
  commentOnly: false,
  criteria: CRITERIA,
  revision: 4,
  comment: 'Submitted comment',
  hiringRecommendation: 'Maybe',
  scores: { [C1]: 5, [C2]: 4 },
  ...overrides,
});
const submitted = (latestCorrection: unknown = null) => ({
  ...summary,
  status: 'Submitted',
  commentOnly: false,
  criteria: CRITERIA,
  submission: {
    submittedAt: '2031-03-05T08:30:00Z',
    submittedBy: { name: 'Synthetic Mentor' },
    comment: 'Submitted comment',
    hiringRecommendation: 'Maybe',
    scores: { [C1]: 5, [C2]: 4 },
    grade: 'Excellent',
    latestCorrection,
  },
});
const en = () => testI18n(JSON.parse(enMessages), 'en');
const ar = () => testI18n(JSON.parse(arMessages), 'ar');

const routesFor = (base: string) => [
  { path: `${base}/:applicationId`, element: <EvaluationPage base={base} /> },
  { path: `${base}/:applicationId/correct`, element: <CorrectionPage base={base} /> },
];
const openCorrection = (
  respond: Parameters<typeof mockFetch>[0],
  i18n = en(),
  base = '/employee/evaluations',
) => {
  const fetchMock = mockFetch(respond);
  const view = renderRoutes(routesFor(base), { url: `${base}/${APP}/correct`, i18n });
  return { fetchMock, view };
};
const posts = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls
    .filter((c) => c[1]?.method === 'POST')
    .map((c) => [c[0], JSON.parse(String(c[1]!.body))]);
/** The term → definition pairs of a description list (dt/dd), as a reader hears them. */
const pairs = (container: HTMLElement) =>
  Object.fromEntries(
    within(container)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
  );
const criterion = (name: string) => screen.getByRole('group', { name: new RegExp(name) });

describe('Read-only submitted evaluation (S2.4): the correction action and the latest correction', () => {
  const open = (body: unknown, i18n = en()) => {
    mockFetch(() => [200, body]);
    return renderRoutes(routesFor('/hr/evaluations'), { url: `/hr/evaluations/${APP}`, i18n });
  };

  it('offers “Correct Evaluation”, a link to the separate correction page; no correction shown when there is none', async () => {
    open(submitted());
    const link = await screen.findByRole('link', { name: 'Correct Evaluation' });
    expect(link).toHaveAttribute('href', `/hr/evaluations/${APP}/correct`);
    expect(screen.queryByRole('heading', { name: 'Latest Correction' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toEqual([]); // the submitted page stays read-only
  });

  it('shows the latest correction only: who, when and why; never an id or an earlier value', async () => {
    open(
      submitted({
        correctedAt: '2031-03-06T09:00:00Z',
        correctedBy: { name: 'Synthetic HR' },
        reason: 'A typo in the comment',
      }),
    );
    const block = (await screen.findByRole('heading', { name: 'Latest Correction' })).closest(
      'section',
    )!;
    // A description list like the submission's own details; the colons come from the translations only.
    expect(pairs(block)).toEqual({
      'Corrected by:': 'Synthetic HR',
      'Corrected on:': new Date('2031-03-06T09:00:00Z').toLocaleString('en'),
      Reason: 'A typo in the comment',
    });
    expect(block.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    // The original submission stays as it was: its submitter and time.
    const submission = pairs(block.parentElement!.querySelector('dl')!);
    expect(submission['Submitted by']).toBe('Synthetic Mentor');
    expect(submission['Submitted on']).toBe(new Date('2031-03-05T08:30:00Z').toLocaleString('en'));
  });

  it('a correction without a reason shows no reason', async () => {
    open(
      submitted({
        correctedAt: '2031-03-06T09:00:00Z',
        correctedBy: { name: 'Synthetic HR' },
        reason: null,
      }),
    );
    const block = (await screen.findByRole('heading', { name: 'Latest Correction' })).closest(
      'section',
    )!;
    expect(Object.keys(pairs(block))).toEqual(['Corrected by:', 'Corrected on:']);
  });

  it('reads in Arabic with the approved wording', async () => {
    open(
      submitted({
        correctedAt: '2031-03-06T09:00:00Z',
        correctedBy: { name: 'Synthetic HR' },
        reason: null,
      }),
      ar(),
    );
    expect(await screen.findByRole('link', { name: 'تصحيح التقييم' })).toBeInTheDocument();
    const block = screen.getByRole('heading', { name: 'آخر تصحيح' }).closest('section')!;
    expect(pairs(block)).toEqual({
      'صحّحه:': 'Synthetic HR',
      'تاريخ التصحيح:': new Date('2031-03-06T09:00:00Z').toLocaleString('ar'),
    });
  });
});

describe('Correction page (S2.4)', () => {
  it('starts from the current values: every frozen score, the comment and the recommendation; an empty reason', async () => {
    openCorrection(() => [200, start()]);
    expect(
      await screen.findByRole('heading', { name: 'Correct Final Evaluation' }),
    ).toBeInTheDocument();
    expect(within(criterion('Punctuality')).getByRole('radio', { name: '5' })).toBeChecked();
    expect(within(criterion('Attendance')).getByRole('radio', { name: '4' })).toBeChecked();
    expect(screen.getByLabelText('Comment')).toHaveValue('Submitted comment');
    expect(screen.getByRole('radio', { name: 'Maybe' })).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'Not chosen' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reason (optional)')).toHaveValue('');
    expect(screen.getByText('0 / 2000')).toBeInTheDocument();
  });

  it('saves after an explicit confirmation, one request with every value, then returns to the read-only page', async () => {
    const user = userEvent.setup();
    const { fetchMock, view } = openCorrection((method, url) =>
      method === 'POST'
        ? [200, submitted()]
        : url.endsWith('/correction')
          ? [200, start()]
          : [
              200,
              submitted({
                correctedAt: '2031-03-06T09:00:00Z',
                correctedBy: { name: 'Synthetic Mentor' },
                reason: 'Typo',
              }),
            ],
    );
    await user.click(
      within(await screen.findByRole('group', { name: /Attendance/ })).getByRole('radio', {
        name: '2',
      }),
    );
    await user.type(screen.getByLabelText('Reason (optional)'), '  Typo  ');
    expect(screen.getByText('8 / 2000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));

    const dialog = await screen.findByRole('dialog', { name: 'Confirm Correction' });
    expect(dialog).toHaveTextContent(
      'The correction will be saved immediately, recording who made it and when. The original submitter and submission time will remain unchanged.',
    );
    expect(posts(fetchMock)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Save Correction' }));

    expect(
      await screen.findByText('Evaluation correction saved successfully.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(`/employee/evaluations/${APP}`),
    );
    expect(await screen.findByRole('heading', { name: 'Latest Correction' })).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([
      [
        `/api/evaluations/${APP}/corrections`,
        {
          revision: 4,
          comment: 'Submitted comment',
          hiringRecommendation: 'Maybe',
          scores: { [C1]: 5, [C2]: 2 },
          reason: 'Typo',
        },
      ],
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // no "leave without saving" question
  });

  it('cancelling the confirmation sends nothing', async () => {
    const user = userEvent.setup();
    const { fetchMock } = openCorrection(() => [200, start()]);
    await user.click(await screen.findByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(posts(fetchMock)).toEqual([]);
  });

  it.each([
    ['nothing changed', async () => undefined],
    [
      'only a reason',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.type(screen.getByLabelText('Reason (optional)'), 'Why'),
    ],
    [
      'a value changed and changed back',
      async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('radio', { name: 'Yes' }));
        await user.click(screen.getByRole('radio', { name: 'Maybe' }));
      },
    ],
    [
      'only spaces around the comment',
      async (user: ReturnType<typeof userEvent.setup>) =>
        user.type(screen.getByLabelText('Comment'), '   '),
    ],
  ])('%s: “There are no changes to save.” and nothing is sent', async (_label, act) => {
    const user = userEvent.setup();
    const { fetchMock } = openCorrection(() => [200, start()]);
    await screen.findByLabelText('Comment');
    await act(user);
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There are no changes to save.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(fetchMock)).toEqual([]);
  });

  it('requires a comment and refuses a reason over 2,000 characters next to the field; nothing is sent', async () => {
    const user = userEvent.setup();
    const { fetchMock } = openCorrection(() => [200, start()]);
    const comment = await screen.findByLabelText('Comment');
    await user.clear(comment);
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    expect(comment).toHaveAttribute('aria-invalid', 'true');
    expect(comment).toHaveAccessibleDescription(expect.stringContaining('Enter a comment.'));

    await user.type(comment, 'Changed');
    const reason = screen.getByLabelText('Reason (optional)');
    await user.click(reason);
    await user.paste('ع'.repeat(2001));
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason).toHaveAccessibleDescription(
      expect.stringContaining('The reason must be at most 2000 characters.'),
    );
    expect(posts(fetchMock)).toEqual([]);
  });

  it('a stale revision: the approved message, nothing resent; “Load Latest Version” loads the current values', async () => {
    const user = userEvent.setup();
    let latest = false;
    const { fetchMock } = openCorrection((method) =>
      method === 'POST'
        ? [409, { status: 409, code: 'conflict.concurrent_update' }]
        : [200, latest ? start({ revision: 5, comment: 'Corrected by HR' }) : start()],
    );
    await user.click(await screen.findByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save Correction' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This evaluation was updated by another user. Load the latest version before correcting it again.',
    );
    const save = screen.getByRole('button', { name: 'Save Correction' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await user.click(save);
    expect(posts(fetchMock)).toHaveLength(1); // never resent

    latest = true;
    await user.click(within(alert).getByRole('button', { name: 'Load Latest Version' }));
    expect(await screen.findByDisplayValue('Corrected by HR')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Maybe' })).toBeChecked();
  });

  it.each([403, 404, 409])(
    'a lost right to correct (%s) disables saving; nothing is resent',
    async (status) => {
      const user = userEvent.setup();
      const { fetchMock } = openCorrection((method) =>
        method === 'POST'
          ? [status, { status, code: status === 409 ? 'evaluation.not_submitted' : undefined }]
          : [200, start()],
      );
      await user.click(await screen.findByRole('radio', { name: 'No' }));
      await user.click(screen.getByRole('button', { name: 'Save Correction' }));
      await user.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save Correction' }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'You can no longer correct this evaluation.',
      );
      await user.click(screen.getByRole('button', { name: 'Save Correction' }));
      expect(posts(fetchMock)).toHaveLength(1);
    },
  );

  it('sends one request only, however often it is confirmed while in progress; never retried', async () => {
    const user = userEvent.setup();
    let release: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => (release = resolve))
        : new Response(JSON.stringify(start()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderRoutes(routesFor('/employee/evaluations'), {
      url: `/employee/evaluations/${APP}/correct`,
      i18n: en(),
    });
    await user.click(await screen.findByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save Correction' }));
    const pending = within(dialog).getByRole('button', { name: 'Saving…' });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(pending);
    release(new Response(null, { status: 503 }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The correction could not be confirmed.',
    );
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1);
  });

  it('asks before leaving with unsaved changes: stay keeps them, leave goes', async () => {
    const user = userEvent.setup();
    openCorrection((_m, url) => [200, url.endsWith('/correction') ? start() : submitted()]);
    await user.click(await screen.findByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('link', { name: 'Back to the evaluation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(dialog).toHaveTextContent('Your correction has not been saved');
    await user.click(within(dialog).getByRole('button', { name: 'Stay on this page' }));
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeChecked();
    await user.click(screen.getByRole('link', { name: 'Back to the evaluation' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Leave without saving',
      }),
    );
    expect(await screen.findByRole('link', { name: 'Correct Evaluation' })).toBeInTheDocument();
  });

  it('a comment-only evaluation has no scores to correct and sends {}', async () => {
    const user = userEvent.setup();
    const { fetchMock } = openCorrection((method) =>
      method === 'POST'
        ? [200, submitted()]
        : [200, start({ commentOnly: true, criteria: [], scores: {} })],
    );
    expect(
      await screen.findByText('This evaluation was submitted with a written comment only.'),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('radio', { name: /^[1-5]$/ })).toEqual([]);
    await user.click(screen.getByRole('radio', { name: 'Yes' }));
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save Correction' }),
    );
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1));
    expect(posts(fetchMock)[0]![1]).toMatchObject({
      scores: {},
      hiringRecommendation: 'Yes',
      reason: null,
    });
  });

  it('cannot be opened when the evaluation is not correctable: not found, or no longer available', async () => {
    openCorrection(() => [404, { status: 404 }]);
    expect(await screen.findByRole('alert')).toHaveTextContent('This evaluation was not found.');
  });

  it('reads in Arabic with the approved wording', async () => {
    const user = userEvent.setup();
    openCorrection(() => [200, start()], ar());
    expect(
      await screen.findByRole('heading', { name: 'تصحيح التقييم النهائي' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('السبب (اختياري)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'حفظ التصحيح' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('لا توجد تغييرات لحفظها.');
    await user.click(screen.getByRole('radio', { name: 'لا' }));
    await user.click(screen.getByRole('button', { name: 'حفظ التصحيح' }));
    const dialog = await screen.findByRole('dialog', { name: 'تأكيد حفظ التصحيح' });
    expect(dialog).toHaveTextContent(
      'سيتم حفظ التصحيح فورًا مع تسجيل اسم المصحّح ووقت التصحيح. سيبقى المُقدِّم الأصلي ووقت التقديم دون تغيير.',
    );
    const messages = JSON.parse(arMessages).evaluation.correction;
    expect([messages.success, messages.conflict, messages.reload]).toEqual([
      'تم حفظ تصحيح التقييم بنجاح.',
      'تم تعديل التقييم بواسطة مستخدم آخر. يُرجى تحميل آخر نسخة قبل التصحيح مجددًا.',
      'تحميل آخر نسخة',
    ]);
  });

  it('the S2.3 submission confirmation wording is unchanged', () => {
    expect(JSON.parse(enMessages).evaluation.submit.confirmText).toBe(
      'After submission, you will not be able to edit this evaluation from this page.',
    );
  });
});

describe('Correction page: an expired session (401)', () => {
  const employee: SessionUser = {
    id: 'u1',
    role: 'Employee',
    email: 'u@company.example',
    name: null,
  };

  /**
   * The real guard (RequireRole) with a session that `refresh()` finds ended, as AuthProvider does on 401: the user is
   * then signed out and the guard sends them to sign in. Returns how often the session was re-checked.
   */
  function openWithSession(respond: Parameters<typeof mockFetch>[0]) {
    const fetchMock = mockFetch(respond);
    const checks = { count: 0 };
    function Session({ children }: { children: React.ReactNode }) {
      const [user, setUser] = useState<SessionUser | null>(employee);
      const auth = useMemo(
        () =>
          fakeAuth({
            user,
            refresh: async () => {
              checks.count++;
              setUser(null);
              return null;
            },
          }),
        [user],
      );
      return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
    }
    const router = createMemoryRouter(
      [
        {
          path: '/employee',
          element: <RequireRole role="Employee" />,
          children: [
            {
              path: 'evaluations/:applicationId',
              element: <EvaluationPage base="/employee/evaluations" />,
            },
            {
              path: 'evaluations/:applicationId/correct',
              element: <CorrectionPage base="/employee/evaluations" />,
            },
          ],
        },
        { path: '/sign-in', element: <p>Sign-in page</p> },
      ],
      { initialEntries: [`/employee/evaluations/${APP}/correct`] },
    );
    render(
      <I18nContext.Provider value={en()}>
        <Session>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </Session>
      </I18nContext.Provider>,
    );
    return { fetchMock, checks, router };
  }

  it('on opening: the session is checked once, the guard sends the user to sign in; no error is shown', async () => {
    const { fetchMock, checks, router } = openWithSession(() => [401]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    expect(checks.count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
    expect(
      screen.queryByText('You can no longer correct this evaluation.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('on saving: one request, the session is checked, then sign-in without the unsaved-changes question', async () => {
    const user = userEvent.setup();
    const { fetchMock, checks, router } = openWithSession((method) =>
      method === 'POST' ? [401] : [200, start()],
    );
    await user.click(await screen.findByRole('radio', { name: 'No' }));
    await user.click(screen.getByRole('button', { name: 'Save Correction' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save Correction' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toBe(
      `?returnUrl=${encodeURIComponent(`/employee/evaluations/${APP}/correct`)}`,
    );
    expect(checks.count).toBe(1);
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1); // never resent
    expect(screen.queryByRole('dialog', { name: 'Leave without saving?' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('You can no longer correct this evaluation.'),
    ).not.toBeInTheDocument();
  });
});

describe('Correction routes (Employee and HR only)', () => {
  it.each([
    ['Employee', '/employee/evaluations'],
    ['HR', '/hr/evaluations'],
  ] as const)('the %s area opens the correction page', async (role, base) => {
    mockFetch((_m, url) =>
      url.endsWith('/correction')
        ? [200, start()]
        : [200, { unreadCount: 0, hasMore: false, notifications: [] }],
    );
    renderRoutes(routes, {
      url: `${base}/${APP}/correct`,
      auth: fakeAuth({ user: { id: 'u1', role, email: 'u@company.example', name: null } }),
      i18n: en(),
    });
    expect(
      await screen.findByRole('heading', { name: 'Correct Final Evaluation' }),
    ).toBeInTheDocument();
  });

  it('the Admin has no correction page', async () => {
    mockFetch(() => [200, []]);
    renderRoutes(routes, {
      url: `/admin/evaluations/${APP}/correct`,
      auth: fakeAuth({ user: { id: 'u1', role: 'Admin', email: 'u@company.example', name: null } }),
      i18n: en(),
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Correct Final Evaluation' }),
      ).not.toBeInTheDocument(),
    );
  });
});
