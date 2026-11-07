import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { ApiError } from '../../lib/api';
import { fakeAuth, mockFetch, renderPage, testI18n } from '../../test/render';
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

  describe('role change rules (AUD-01, AUD-02, AUD-03)', () => {
    const person = (id: string, fullName: string, role: string) => ({
      id,
      fullName,
      email: `${id}@company.example`,
      department: null,
      role,
    });
    const signedInAs = (id: string) =>
      fakeAuth({ user: { id, role: 'Admin', email: `${id}@company.example`, name: 'Me' } });
    const everyone = [person('me', 'Me', 'Admin'), person('u2', 'Other Admin', 'Admin')];
    const select = (name: string) =>
      screen.findByRole('combobox', { name: `admin.users.role: ${name}` });

    it('disables only the signed-in Admin’s own role, says why, and sends nothing', async () => {
      const fetchMock = mockFetch(() => [200, everyone]);
      renderPage(<UsersPage />, { auth: signedInAs('me') });
      const own = await select('Me');
      expect(own).toBeDisabled();
      expect(own).toHaveAccessibleDescription('admin.users.ownRole');
      await userEvent.setup().selectOptions(own, 'HR');
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toEqual([]);

      const other = await select('Other Admin');
      expect(other).toBeEnabled();
      expect(other).not.toHaveAttribute('aria-describedby');
      expect(screen.getAllByText('admin.users.ownRole')).toHaveLength(1);
    });

    it('lets an Admin change another Admin', async () => {
      const fetchMock = mockFetch((method) =>
        method === 'GET' ? [200, everyone] : [200, person('u2', 'Other Admin', 'Employee')],
      );
      renderPage(<UsersPage />, { auth: signedInAs('me') });
      const other = await select('Other Admin');
      await userEvent.setup().selectOptions(other, 'Employee');
      await waitFor(() => expect(other).toHaveValue('Employee'));
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/users/u2/role',
        expect.objectContaining({ method: 'PUT', body: '{"role":"Employee"}' }),
      );
    });

    it.each([
      [409, 'employee.last_admin', 'admin.users.lastAdmin'],
      [403, 'employee.self_role_change', 'admin.users.ownRole'],
    ])('explains a %i %s and shows the stored role again', async (status, code, message) => {
      mockFetch((method) =>
        method === 'GET' ? [200, everyone] : [status, { status, code, detail: 'technical detail' }],
      );
      renderPage(<UsersPage />, { auth: signedInAs('me') });
      const other = await select('Other Admin');
      await userEvent.setup().selectOptions(other, 'Employee');
      await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
      expect(screen.queryByText('technical detail')).not.toBeInTheDocument();
      expect(await select('Other Admin')).toHaveValue('Admin');
    });

    it.each([
      ['en', enMessages, "You can't change your own role", 'no Admin'],
      ['ar', arMessages, 'لا يمكنك تغيير دورك بنفسك', 'بلا مدير'],
    ] as const)('reads in %s', async (language, raw, own, last) => {
      mockFetch((method) =>
        method === 'GET'
          ? [200, everyone]
          : [409, { status: 409, code: 'employee.last_admin', detail: 'x' }],
      );
      renderPage(<UsersPage />, {
        auth: signedInAs('me'),
        i18n: testI18n(JSON.parse(raw), language),
      });
      expect(await screen.findByText(new RegExp(own))).toBeInTheDocument();
      const others = await screen.findAllByRole('combobox');
      await userEvent.setup().selectOptions(others[1]!, 'Employee');
      expect(await screen.findByText(new RegExp(last))).toBeInTheDocument();
    });
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

  it('gives the role rules their own message; another 409 stays as it was', () => {
    const error = (status: number, code: string) => new ApiError(status, { code });
    expect(adminErrorKey(error(409, 'employee.last_admin'))).toBe('admin.users.lastAdmin');
    expect(adminErrorKey(error(403, 'employee.self_role_change'))).toBe('admin.users.ownRole');
    expect(adminErrorKey(error(409, 'conflict.duplicate'))).toBe('admin.errors.conflict');
  });
});
