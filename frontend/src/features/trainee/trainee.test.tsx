import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderPage, renderRoutes } from '../../test/render';
import { ApplyPage } from './ApplyPage';
import { TraineeHome } from './TraineeHome';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers the form's data, and records the multipart submission. */
const NO_PROFILE = {
  email: 't@uni.example',
  fullName: null,
  phone: null,
  university: null,
  major: null,
  studyYear: null,
};
const RECORDED = {
  email: 't@uni.example',
  fullName: 'Lina Haddad',
  phone: '000-0000',
  university: 'Example University',
  major: 'Computer Engineering',
  studyYear: 'Fourth year',
};

function formApi(submission: (form: FormData) => Response, profile: object = NO_PROFILE) {
  const sent: FormData[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/trainee/fields')
        return json(200, [{ id: 'f1', name: 'Backend', description: null }]);
      if (url === '/api/trainee/profile') return json(200, profile);
      sent.push(init!.body as FormData);
      return submission(init!.body as FormData);
    }),
  );
  return sent;
}

describe('application form (PDF §4)', () => {
  async function fill(
    user: ReturnType<typeof userEvent.setup>,
    { cv = true, profile = true } = {},
  ) {
    if (profile) {
      await user.type(screen.getByLabelText('training.profile.fullName'), 'Lina Haddad');
      await user.type(screen.getByLabelText('training.profile.phone'), '000-0000');
      await user.type(screen.getByLabelText('training.profile.university'), 'Example University');
      await user.type(screen.getByLabelText('training.profile.major'), 'Computer Engineering');
      await user.type(screen.getByLabelText('training.profile.studyYear'), 'Fourth year');
    }
    await user.selectOptions(screen.getByLabelText('training.fields.field'), 'f1');
    await user.type(screen.getByLabelText('training.fields.availableFrom'), '2027-02-01');
    await user.type(screen.getByLabelText('training.fields.availableTo'), '2027-04-30');
    await user.type(screen.getByLabelText('training.fields.hours'), '240');
    await user.click(screen.getByLabelText('training.yes'));
    if (cv)
      await user.upload(
        screen.getByLabelText('training.attachmentKind.Cv'),
        new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }),
      );
  }

  it('sends every PDF field, the CV and any letters as one multipart form, then shows the status board', async () => {
    const sent = formApi(() => json(201, { id: 'a1', status: 'Submitted' }));
    const { router } = renderPage(<ApplyPage />, { url: '/trainee/apply' });
    const user = userEvent.setup();
    expect(await screen.findByLabelText('training.profile.fullName')).toHaveValue(''); // first application
    await fill(user);
    await user.upload(
      screen.getByLabelText('trainee.apply.letters'),
      new File(['letter'], 'letter.pdf', { type: 'application/pdf' }),
    );

    await user.click(screen.getByRole('button', { name: 'trainee.apply.submit' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/trainee'));
    const form = sent[0]!;
    expect(
      Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string')),
    ).toEqual({
      fullName: 'Lina Haddad',
      phone: '000-0000',
      university: 'Example University',
      major: 'Computer Engineering',
      studyYear: 'Fourth year',
      fieldId: 'f1',
      availableFrom: '2027-02-01',
      availableTo: '2027-04-30',
      hours: '240',
      mandatoryForUniversity: 'true',
    });
    expect((form.get('cv') as File).name).toBe('cv.pdf');
    expect((form.getAll('letters') as File[]).map((f) => f.name)).toEqual(['letter.pdf']);
  });

  it('after the first application, shows the recorded profile without sending or changing it', async () => {
    const sent = formApi(() => json(201, { id: 'a2', status: 'Submitted' }), RECORDED);
    renderPage(<ApplyPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('trainee.apply.profileRecorded')).toBeInTheDocument();
    expect(screen.getByText('Example University')).toBeInTheDocument();
    expect(screen.queryByLabelText('training.profile.fullName')).not.toBeInTheDocument(); // not editable
    await fill(user, { profile: false });
    await user.click(screen.getByRole('button', { name: 'trainee.apply.submit' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(
      ['fullName', 'phone', 'university', 'major', 'studyYear'].filter((name) =>
        sent[0]!.has(name),
      ),
    ).toEqual([]);
  });

  it('asks for the CV before sending anything', async () => {
    const sent = formApi(() => json(201, { id: 'a1' }));
    renderPage(<ApplyPage />);
    const user = userEvent.setup();
    await screen.findByLabelText('training.profile.fullName');
    await fill(user, { cv: false });
    await user.click(screen.getByRole('button', { name: 'trainee.apply.submit' }));
    expect(screen.getByRole('alert')).toHaveTextContent('trainee.apply.errors.cvRequired');
    expect(screen.getByLabelText('training.attachmentKind.Cv')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(sent).toHaveLength(0);
  });

  it('shows the reason when the API refuses the application', async () => {
    formApi(() => json(400, { status: 400, code: 'application.invalid_period' }));
    renderPage(<ApplyPage />);
    const user = userEvent.setup();
    await screen.findByLabelText('training.profile.fullName');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'trainee.apply.submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('trainee.apply.errors.period');
  });

  it('says so when no training field is open', async () => {
    mockFetch((_m, url) =>
      url === '/api/trainee/fields' ? [200, []] : [200, { email: 't@uni.example' }],
    );
    renderPage(<ApplyPage />);
    expect(await screen.findByText('trainee.apply.noFields')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'trainee.apply.submit' })).not.toBeInTheDocument();
  });
});

describe('status board', () => {
  it("lists the trainee's own applications with their status, and opens a file through a temporary link", async () => {
    const fetchMock = mockFetch((method) => {
      if (method === 'POST')
        return [200, { url: '/api/files?token=abc', expiresAt: '2027-01-01T00:00:00Z' }];
      return [
        200,
        [
          {
            id: 'a1',
            field: { id: 'f1', name: 'Backend' },
            status: 'UnderReview',
            availableFrom: '2027-02-01',
            availableTo: '2027-04-30',
            hours: 240,
            mandatoryForUniversity: true,
            submittedAt: '2026-10-29T10:00:00Z',
            decidedAt: null,
            attachments: [{ id: 'x1', kind: 'Cv', fileName: 'cv.pdf', sizeBytes: 4 }],
          },
        ],
      ];
    });
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => tab),
    );
    renderRoutes([{ path: '/trainee', element: <TraineeHome /> }], { url: '/trainee' });
    const user = userEvent.setup();

    const card = (await screen.findByText('Backend')).closest('li')!;
    expect(within(card).getByText('training.applicationStatus.UnderReview')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /cv\.pdf/ }));
    await waitFor(() => expect(tab.location.href).toBe('/api/files?token=abc'));
    expect(tab.opener).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/trainee/attachments/x1/link',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
