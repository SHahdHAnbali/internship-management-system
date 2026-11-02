import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../public/i18n/ar.json?raw';
import enMessages from '../../public/i18n/en.json?raw';
import { AreaShell } from '../components/AreaShell';
import { fakeAuth, mockFetch, renderPage, renderRoutes, testI18n } from '../test/render';
import { NotificationsMenu } from './NotificationsMenu';

afterEach(() => vi.unstubAllGlobals());

const note = (id: string, type: string, isRead = false) => ({
  id,
  type,
  isRead,
  createdAt: '2026-10-31T10:00:00Z',
  applicationId: 'a1',
  traineeName: 'Lina Haddad',
  fieldName: 'QA',
  employeeName: 'Mentor One',
});

describe('NotificationsMenu', () => {
  it('shows the unread count, lists the notifications and opens one: marked read, then its record', async () => {
    let read = false;
    const fetchMock = mockFetch((method) => {
      if (method === 'POST') {
        read = true;
        return [204];
      }
      return [
        200,
        {
          unreadCount: read ? 1 : 2,
          notifications: [
            note('n1', 'ApplicationSubmitted', read),
            note('n2', 'MentorRequestSubmitted'),
            note('n3', 'MentorRequestSubmitted', true),
          ],
        },
      ];
    });
    const { router } = renderRoutes(
      [
        { path: '/hr', element: <NotificationsMenu /> },
        { path: '/hr/applications/:id', element: <p>application page</p> },
      ],
      { url: '/hr' },
    );
    const user = userEvent.setup();

    const button = await screen.findByRole('button', { name: 'notifications.button' });
    await waitFor(() => expect(within(button).getByText('2')).toBeInTheDocument());
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(
      within(items[0]!).getByText(/notifications\.types\.ApplicationSubmitted/),
    ).toBeInTheDocument();
    expect(within(items[0]!).getByText(/notifications\.unread/)).toBeInTheDocument(); // announced as unread
    expect(within(items[2]!).queryByText(/notifications\.unread/)).not.toBeInTheDocument();

    await user.click(within(items[0]!).getByRole('button'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/hr/applications/a1'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications/n1/read',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not mark an already read notification again', async () => {
    const fetchMock = mockFetch(() => [
      200,
      { unreadCount: 0, notifications: [note('n1', 'MentorRequestApproved', true)] },
    ]);
    const { router } = renderRoutes(
      [
        { path: '/employee', element: <NotificationsMenu /> },
        { path: '/employee/trainees', element: <p>my trainees</p> },
      ],
      { url: '/employee' },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'notifications.button' }));
    await user.click(within(await screen.findByRole('listitem')).getByRole('button'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/employee/trainees'));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('says when there are none, and shows a load error without details', async () => {
    mockFetch(() => [200, { unreadCount: 0, notifications: [] }]);
    const user = userEvent.setup();
    const { unmount } = renderPage(<NotificationsMenu />);
    await user.click(await screen.findByRole('button', { name: 'notifications.button' }));
    expect(await screen.findByText('notifications.empty')).toBeInTheDocument();
    unmount();

    mockFetch(() => [500, { detail: 'Stack trace', code: 'internal' }]);
    renderPage(<NotificationsMenu />);
    await user.click(await screen.findByRole('button', { name: 'notifications.button' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('notifications.loadFailed');
    expect(screen.queryByText(/Stack trace|internal|500/)).not.toBeInTheDocument();
  });

  it.each([
    [
      'ar',
      arMessages,
      'الإشعارات، 1 غير مقروءة',
      'اعتمدت الموارد البشرية طلبك لتدريب Lina Haddad',
      'تعذّر تحميل الإشعارات. يرجى المحاولة مرة أخرى.',
    ],
    [
      'en',
      enMessages,
      'Notifications, 1 unread',
      'HR approved your request to train Lina Haddad',
      'Unable to load notifications. Please try again.',
    ],
  ] as const)('reads in %s', async (language, raw, label, text, failure) => {
    const i18n = testI18n(JSON.parse(raw), language);
    mockFetch(() => [
      200,
      { unreadCount: 1, notifications: [note('n1', 'MentorRequestApproved')] },
    ]);
    const user = userEvent.setup();
    const { unmount } = renderPage(<NotificationsMenu />, { i18n });
    await user.click(await screen.findByRole('button', { name: label }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    unmount();

    mockFetch(() => [500]);
    renderPage(<NotificationsMenu />, { i18n });
    await user.click(await screen.findByRole('button', { name: /^(الإشعارات|Notifications)/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(failure);
  });
});

describe('NotificationsMenu: load more (owner decision C3)', () => {
  const page1 = {
    unreadCount: 3,
    hasMore: true,
    notifications: [
      note('n1', 'MentorRequestApproved', true),
      note('n2', 'MentorRequestApproved', true),
    ],
  };
  const page2 = {
    unreadCount: 3,
    hasMore: false,
    // n2 again (as if the server sent an overlap): it must not be shown twice.
    notifications: [note('n2', 'MentorRequestApproved', true), note('n3', 'MentorRequestRejected')],
  };

  it('loads older pages after the last one shown, without repeats, until there are no more', async () => {
    const fetchMock = mockFetch((method, url) => {
      if (method === 'POST') return [204];
      return [200, url.includes('before=n2') ? page2 : page1];
    });
    const { router } = renderRoutes(
      [
        { path: '/employee', element: <NotificationsMenu /> },
        { path: '/employee/trainees', element: <p>my trainees</p> },
      ],
      { url: '/employee' },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'notifications.button' }));
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'notifications.loadMore' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications?before=n2', expect.anything());
    expect(
      screen.queryByRole('button', { name: 'notifications.loadMore' }),
    ).not.toBeInTheDocument();

    // The older unread one is reachable and is marked read when opened.
    const oldest = screen.getAllByRole('listitem')[2]!;
    expect(within(oldest).getByText(/notifications\.unread/)).toBeInTheDocument();
    await user.click(within(oldest).getByRole('button'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/employee/trainees'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications/n3/read',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps what is shown and reports the error when an older page fails', async () => {
    mockFetch((_method, url) =>
      url.includes('before=') ? [500, { detail: 'boom' }] : [200, page1],
    );
    const user = userEvent.setup();
    renderPage(<NotificationsMenu />);
    await user.click(await screen.findByRole('button', { name: 'notifications.button' }));
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('button', { name: 'notifications.loadMore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('notifications.loadFailed');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  it('shows the unread count from the server, not just the loaded page', async () => {
    mockFetch(() => [200, { ...page1, unreadCount: 42 }]);
    renderPage(<NotificationsMenu />);
    const button = await screen.findByRole('button', { name: 'notifications.button' });
    await waitFor(() => expect(within(button).getByText('42')).toBeInTheDocument());
  });
});

describe('the area header', () => {
  it.each([
    ['HR', true],
    ['Employee', true],
    ['Trainee', false],
    ['Admin', false],
    [null, false],
  ] as const)('shows notifications to %s: %s', async (role, shown) => {
    const fetchMock = mockFetch(() => [200, { unreadCount: 0, notifications: [] }]);
    renderPage(
      <AreaShell>
        <p>content</p>
      </AreaShell>,
      { auth: fakeAuth({ user: { id: 'u1', role, email: 'u@company.example', name: null } }) },
    );
    expect(await screen.findByText('content')).toBeInTheDocument();
    if (shown) {
      expect(
        await screen.findByRole('button', { name: 'notifications.button' }),
      ).toBeInTheDocument();
    } else {
      expect(
        screen.queryByRole('button', { name: 'notifications.button' }),
      ).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith('/api/notifications', expect.anything());
    }
  });
});
