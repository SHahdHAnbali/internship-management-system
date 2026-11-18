import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderPage, testI18n } from '../../test/render';
import { CriteriaPage } from './CriteriaPage';

afterEach(() => vi.unstubAllGlobals());

const criteria = [
  { id: '1', nameAr: 'التزام بالمواعيد', nameEn: 'Punctuality', sortOrder: 1, isActive: true },
  {
    id: '2',
    nameAr: 'حضور وغياب',
    nameEn: 'Attendance and Absence',
    sortOrder: 2,
    isActive: false,
  },
];

const sentBody = (fetchMock: ReturnType<typeof mockFetch>, method: string) =>
  JSON.parse(String(fetchMock.mock.calls.find((c) => c[1]?.method === method)![1]!.body));

describe('CriteriaPage (AD-66: Arabic and English names, order, active flag; no weights)', () => {
  it('lists both names in their own language and direction, the order and the active flag, without weights', async () => {
    mockFetch(() => [200, criteria]);
    renderPage(<CriteriaPage />);

    const rows = await screen.findAllByRole('row');
    expect(
      within(rows[0])
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'admin.criteria.order',
      'admin.criteria.nameAr',
      'admin.criteria.nameEn',
      'admin.criteria.active',
      'admin.actions.edit',
    ]);
    const arabic = within(rows[1]).getByText('التزام بالمواعيد');
    expect([arabic.getAttribute('lang'), arabic.getAttribute('dir')]).toEqual(['ar', 'rtl']);
    const english = within(rows[1]).getByText('Punctuality');
    expect([english.getAttribute('lang'), english.getAttribute('dir')]).toEqual(['en', 'ltr']);
    expect(within(rows[2]).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/weight/i)).not.toBeInTheDocument();
  });

  it('names each switch after the criterion in the interface language', async () => {
    mockFetch(() => [200, criteria]);
    renderPage(<CriteriaPage />, { i18n: testI18n(null, 'en') });

    expect(
      await screen.findByRole('switch', { name: 'admin.criteria.active: Punctuality' }),
    ).toBeInTheDocument();
  });

  it('deactivates a criterion through the API, keeping its names and order', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'GET' ? [200, criteria] : [200, { ...criteria[0], isActive: false }],
    );
    renderPage(<CriteriaPage />);

    const rows = await screen.findAllByRole('row');
    await userEvent.setup().click(within(rows[1]).getByRole('switch'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/evaluation-criteria/1',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    expect(sentBody(fetchMock, 'PUT')).toEqual({
      nameAr: 'التزام بالمواعيد',
      nameEn: 'Punctuality',
      sortOrder: 1,
      isActive: false,
    });
  });

  it('adds a criterion with both names, trimmed; the name fields keep their own direction', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'GET'
        ? [200, []]
        : [
            201,
            { id: '9', nameAr: 'العمل الجماعي', nameEn: 'Teamwork', sortOrder: 3, isActive: true },
          ],
    );
    renderPage(<CriteriaPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'admin.criteria.add' }));

    const arabic = screen.getByLabelText(/admin.criteria.nameAr/);
    const english = screen.getByLabelText(/admin.criteria.nameEn/);
    expect([arabic.getAttribute('lang'), arabic.getAttribute('dir')]).toEqual(['ar', 'rtl']);
    expect([english.getAttribute('lang'), english.getAttribute('dir')]).toEqual(['en', 'ltr']);
    expect(screen.queryByLabelText(/weight/i)).not.toBeInTheDocument();
    await user.type(arabic, ' العمل الجماعي ');
    await user.type(english, ' Teamwork ');
    await user.clear(screen.getByLabelText(/admin.criteria.order/));
    await user.type(screen.getByLabelText(/admin.criteria.order/), '3');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/evaluation-criteria',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(sentBody(fetchMock, 'POST')).toEqual({
      nameAr: 'العمل الجماعي',
      nameEn: 'Teamwork',
      sortOrder: 3,
    });
  });

  it('edits a criterion, keeping its active flag', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'GET' ? [200, criteria] : [200, { ...criteria[1], nameEn: 'Attendance' }],
    );
    renderPage(<CriteriaPage />);
    const user = userEvent.setup();
    const rows = await screen.findAllByRole('row');
    await user.click(within(rows[2]).getByRole('button', { name: 'admin.actions.edit' }));

    const english = screen.getByLabelText(/admin.criteria.nameEn/);
    await user.clear(english);
    await user.type(english, 'Attendance');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/evaluation-criteria/2',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    expect(sentBody(fetchMock, 'PUT')).toEqual({
      nameAr: 'حضور وغياب',
      nameEn: 'Attendance',
      sortOrder: 2,
      isActive: false,
    });
  });

  it('requires both names, with the error linked to the field, and sends nothing', async () => {
    const fetchMock = mockFetch(() => [200, []]);
    renderPage(<CriteriaPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'admin.criteria.add' }));
    await user.type(screen.getByLabelText(/admin.criteria.nameAr/), 'العمل الجماعي');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));

    const english = screen.getByLabelText(/admin.criteria.nameEn/);
    expect(english).toHaveAttribute('aria-invalid', 'true');
    expect(english).toHaveAccessibleDescription('admin.validation.required');
    expect(screen.getByLabelText(/admin.criteria.nameAr/)).toHaveAttribute('aria-invalid', 'false');
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0);
  });
});
