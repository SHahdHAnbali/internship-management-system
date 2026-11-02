import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../lib/api';
import { mockFetch, renderPage } from '../../test/render';
import { adminErrorKey } from './feedback';
import { FieldsPage } from './FieldsPage';
import { isValidDays } from './settingsValidation';
import { SettingsPage } from './SettingsPage';
import { UsersPage } from './UsersPage';

afterEach(() => vi.unstubAllGlobals());

describe('FieldsPage', () => {
  it('lists the fields and toggles one through the API', async () => {
    const fetchMock = mockFetch((method, url) =>
      method === 'GET'
        ? [
            200,
            [
              { id: '1', name: 'Backend', description: 'APIs', isActive: true },
              { id: '2', name: 'QA', description: null, isActive: false },
            ],
          ]
        : [200, { id: '1', name: 'Backend', description: 'APIs', isActive: false, url }],
    );
    renderPage(<FieldsPage />);

    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Backend');

    await userEvent.setup().click(within(rows[1]).getByRole('switch'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/fields/1',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    const putBody = JSON.parse(
      String(fetchMock.mock.calls.find((c) => c[1]?.method === 'PUT')![1]!.body),
    );
    expect(putBody).toEqual({ name: 'Backend', description: 'APIs', isActive: false });
  });

  it('adds a field from the dialog', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'GET'
        ? [200, []]
        : [201, { id: '9', name: 'Mobile', description: null, isActive: true }],
    );
    renderPage(<FieldsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'admin.fields.add' }));
    await user.type(screen.getByLabelText(/admin.fields.name/), ' Mobile ');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/fields',
        expect.objectContaining({ method: 'POST', body: '{"name":"Mobile","description":null}' }),
      ),
    );
  });
});

describe('UsersPage', () => {
  it('offers only the staff roles and sends a role change', async () => {
    const fetchMock = mockFetch((method) =>
      method === 'GET'
        ? [
            200,
            [
              {
                id: 'u1',
                fullName: 'Sara',
                email: 'sara@company.example',
                department: null,
                role: 'Employee',
              },
            ],
          ]
        : [
            200,
            {
              id: 'u1',
              fullName: 'Sara',
              email: 'sara@company.example',
              department: null,
              role: 'HR',
            },
          ],
    );
    renderPage(<UsersPage />);
    const select = await screen.findByRole('combobox');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['Employee', 'HR', 'Admin']);

    await userEvent.setup().selectOptions(select, 'HR');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/u1/role',
        expect.objectContaining({ body: '{"role":"HR"}' }),
      ),
    );
    await waitFor(() => expect(select).toHaveValue('HR'));
  });
});

describe('SettingsPage', () => {
  it('loads the intervals and saves changes, refusing values below one day', async () => {
    const fetchMock = mockFetch((method, _url, body) =>
      method === 'GET'
        ? [
            200,
            {
              trainingEndingNoticeDays: 7,
              lateEvaluationReminderDays: 3,
              pendingRequestAlertDays: 5,
            },
          ]
        : [200, body],
    );
    renderPage(<SettingsPage />);
    const user = userEvent.setup();
    const first = await screen.findByLabelText('admin.settings.trainingEndingNoticeDays');
    await waitFor(() => expect(first).toHaveValue(7));

    await user.clear(first);
    await user.type(first, '0');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));
    expect(screen.getByText('admin.validation.days')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);

    await user.clear(first);
    await user.type(first, '10');
    await user.click(screen.getByRole('button', { name: 'admin.actions.save' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/settings/notifications',
        expect.objectContaining({
          method: 'PUT',
          body: '{"trainingEndingNoticeDays":10,"lateEvaluationReminderDays":3,"pendingRequestAlertDays":5}',
        }),
      ),
    );
  });

  it.each([
    ['1', true],
    ['365', true],
    ['0', false],
    ['366', false],
    ['2.5', false],
    ['', false],
  ])('isValidDays(%s) = %s', (value, valid) => {
    expect(isValidDays(value)).toBe(valid);
  });
});

describe('adminErrorKey', () => {
  it.each([
    [400, 'admin.errors.invalid'],
    [401, 'admin.errors.unauthorized'],
    [403, 'admin.errors.forbidden'],
    [404, 'admin.errors.notFound'],
    [409, 'admin.errors.conflict'],
    [500, 'admin.errors.generic'],
  ])('maps HTTP %i to %s', (status, key) => {
    expect(adminErrorKey(new ApiError(status, null))).toBe(key);
  });
});
