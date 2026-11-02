import { screen, within } from '@testing-library/react';
import enMessages from '../../../public/i18n/en.json?raw';
import arMessages from '../../../public/i18n/ar.json?raw';
import { mockFetch, renderPage, testI18n } from '../../test/render';
import { AcceptedTraineesPage } from './AcceptedTraineesPage';
import { adminCache } from './adminCache';

beforeEach(() => adminCache.clear());
afterEach(() => vi.unstubAllGlobals());

const accepted = (overrides: object = {}) => ({
  applicationId: 'a1',
  trainee: {
    fullName: 'Lina Haddad',
    university: 'An-Najah National University',
    major: 'Computer Engineering',
    studyYear: 'Fourth year',
  },
  fieldName: 'QA',
  availableFrom: '2027-02-01',
  availableTo: '2027-04-30',
  hours: 240,
  mandatoryForUniversity: true,
  acceptedAt: '2026-10-30T10:00:00Z',
  assignments: [],
  ...overrides,
});

describe('AcceptedTraineesPage', () => {
  it('lists the accepted trainees read-only, with their recorded assignments', async () => {
    const fetchMock = mockFetch(() => [
      200,
      [
        accepted(),
        accepted({
          applicationId: 'a2',
          trainee: { fullName: 'Omar Saleh', university: 'Birzeit University' },
          assignments: [
            {
              employeeName: 'Mentor One',
              status: 'Active',
              startDate: '2027-02-01',
              endDate: '2027-04-30',
            },
          ],
        }),
      ],
    ]);
    renderPage(<AcceptedTraineesPage />);

    const lina = (await screen.findByText('Lina Haddad')).closest('tr')!;
    expect(within(lina).getByText('admin.acceptedTrainees.noAssignment')).toBeInTheDocument();
    expect(within(lina).getByText('An-Najah National University')).toBeInTheDocument();
    const omar = screen.getByText('Omar Saleh').closest('tr')!;
    expect(within(omar).getByText('Mentor One')).toBeInTheDocument();
    expect(within(omar).getByText('training.assignmentStatus.Active')).toBeInTheDocument();

    // Owner decision C5: no e-mail, phone or CV.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('training.profile.email');
    expect(headers).not.toContain('training.profile.phone');
    expect(screen.queryByText(/training\.attachmentKind\.Cv/)).not.toBeInTheDocument();

    // Read-only: one GET, no buttons or inputs.
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
      'GET /api/admin/accepted-trainees',
    ]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    mockFetch(() => [200, []]);
    renderPage(<AcceptedTraineesPage />);
    expect(await screen.findByText('admin.acceptedTrainees.empty')).toBeInTheDocument();
  });

  it('shows a load error without technical details', async () => {
    mockFetch(() => [500, { status: 500, detail: 'Stack trace' }]);
    renderPage(<AcceptedTraineesPage />);
    expect(await screen.findByText('admin.errors.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText(/Stack trace|500/)).not.toBeInTheDocument();
  });

  it.each([
    ['ar', arMessages, 'المتدربون المقبولون', 'لا يوجد ربط بعد'],
    ['en', enMessages, 'Accepted trainees', 'No assignment yet'],
  ] as const)('reads in %s', async (language, raw, title, none) => {
    mockFetch(() => [200, [accepted()]]);
    renderPage(<AcceptedTraineesPage />, { i18n: testI18n(JSON.parse(raw), language) });
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(await screen.findByText(none)).toBeInTheDocument();
  });
});
