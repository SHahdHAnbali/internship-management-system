import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ToastProvider } from '../components/Toast';
import { I18nContext } from '../i18n/context';
import { routes } from '../routes';
import { testI18n } from '../test/render';
import { AuthProvider } from './AuthProvider';
import type { SessionUser, UserRole } from './models';

/**
 * Reopening the website (a fresh app reading the HttpOnly session cookie through GET /api/auth/me): only the API's
 * 401/403 means "signed out"; a network or server failure is retried and never treated as a sign-out.
 */
afterEach(() => vi.unstubAllGlobals());

const user = (role: UserRole | null): SessionUser => ({
  id: role ? '01a181df-0000-7000-8000-000000000001' : 'google:123',
  role,
  email: 'someone@stu.najah.edu',
  name: 'Someone',
});

type Answer = number | 'offline';

/** The API as the reopened app sees it: GET /api/auth/me answers `me()`; everything else succeeds. */
function api(me: () => Answer, signedIn: SessionUser) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      });
    if (url === '/api/auth/sign-out' && init?.method === 'POST') return json(204);
    if (url !== '/api/auth/me') return json(200, []);
    const answer = me();
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    return answer === 200 ? json(200, signedIn) : json(answer, { status: answer });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    meCalls: () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me').length,
  };
}

function openApp(url: string) {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  render(
    <I18nContext.Provider value={testI18n()}>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </I18nContext.Provider>,
  );
  return router;
}

const homepage = () => screen.findByRole('heading', { level: 1, name: /home\.titleAccent/ });

describe('reopening the website with a valid session', () => {
  it.each([
    ['Admin', '/admin/fields'],
    ['HR', '/hr'],
    ['Employee', '/employee'],
    ['Trainee', '/trainee'],
    [null, '/account'],
  ] as const)('takes a %s from / to %s without signing in again', async (role, path) => {
    api(() => 200, user(role));
    const router = openApp('/');
    await waitFor(() => expect(router.state.location.pathname).toBe(path));
  });
});

describe('when the session cannot be checked (network or server error)', () => {
  it('shows the public homepage meanwhile, retries, and then takes the signed-in user to their area', async () => {
    let answer: Answer = 503;
    const { meCalls } = api(() => answer, user('Admin'));
    const router = openApp('/');

    await homepage();
    answer = 200; // the API answers again
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/fields'), {
      timeout: 3000,
    });
    expect(meCalls()).toBe(2);
  });

  it('on a protected page, says the server cannot be reached instead of sending the user to sign in', async () => {
    let answer: Answer = 'offline';
    api(() => answer, user('Admin'));
    const router = openApp('/admin/users');

    expect(await screen.findByRole('status')).toHaveTextContent('auth.sessionUnavailable');
    expect(router.state.location.pathname).toBe('/admin/users');

    answer = 200;
    await userEvent.setup().click(screen.getByRole('button', { name: 'auth.retry' }));
    expect(await screen.findByRole('heading', { name: 'admin.users.title' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/users');
  });

  it('checks again as soon as the device is back online', async () => {
    let answer: Answer = 'offline';
    api(() => answer, user('Trainee'));
    const router = openApp('/trainee');
    await screen.findByRole('status');

    answer = 200;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/trainee'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('when the session has ended', () => {
  it('an expired or invalid session (401) shows the homepage and is not retried', async () => {
    const { meCalls } = api(() => 401, user('Admin'));
    const router = openApp('/');
    await homepage();
    await new Promise((resolve) => setTimeout(resolve, 1200)); // longer than the first retry delay
    expect(meCalls()).toBe(1);
    expect(router.state.location.pathname).toBe('/');
  });

  it('an expired session on a protected page goes to sign-in with the page to return to', async () => {
    api(() => 401, user('Admin'));
    const router = openApp('/admin/users');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toBe(`?returnUrl=${encodeURIComponent('/admin/users')}`);
  });

  it.each([
    ['Admin', '/admin/fields'],
    ['Trainee', '/trainee'],
    [null, '/account'],
  ] as const)(
    'a %s signing out lands on the homepage; reopening the website does not sign them in again',
    async (role, area) => {
      let answer: Answer = 200;
      const { fetchMock } = api(() => answer, user(role));
      const router = openApp(area);
      await userEvent.setup().click(await screen.findByRole('button', { name: 'auth.signOut' }));

      await homepage();
      expect(router.state.location.pathname).toBe('/');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/sign-out',
        expect.objectContaining({ method: 'POST' }),
      );

      answer = 401; // the API cleared the cookie
      cleanup(); // the browser is closed
      const reopened = openApp('/');
      await homepage();
      expect(reopened.state.location.pathname).toBe('/');
    },
  );
});
