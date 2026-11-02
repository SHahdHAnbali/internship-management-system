import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider } from './auth/AuthProvider';
import type { SessionUser, UserRole } from './auth/models';
import { ToastProvider } from './components/Toast';
import { I18nContext } from './i18n/context';
import { routes } from './routes';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from './test/render';

/** Opening the website root (`/`): signed-out visitors see the homepage; a valid session goes to the user's area. */
afterEach(() => vi.unstubAllGlobals());

const user = (role: UserRole | null): SessionUser => ({
  id: role ? '01a181df-0000-7000-8000-000000000001' : 'google:123',
  role,
  email: 'someone@stu.najah.edu',
  name: 'Someone',
});

const homepageTitle = () => screen.queryByRole('heading', { level: 1, name: /home\.titleAccent/ });

describe('opening / with the session already known', () => {
  beforeEach(() => mockFetch(() => [200, []])); // the area pages may load their data

  it('shows the public homepage to a signed-out visitor', async () => {
    const { router } = renderRoutes(routes, { url: '/', auth: fakeAuth({ user: null }) });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('home.titleAccent');
    expect(router.state.location.pathname).toBe('/');
  });

  it.each([
    ['Admin', '/admin/fields'], // /admin opens its first page
    ['HR', '/hr'],
    ['Employee', '/employee'],
    ['Trainee', '/trainee'],
    [null, '/account'], // Google account outside the staff domain (no role)
  ] as const)('sends a signed-in %s to %s without showing the homepage', async (role, path) => {
    const { router } = renderRoutes(routes, { url: '/', auth: fakeAuth({ user: user(role) }) });
    await waitFor(() => expect(router.state.location.pathname).toBe(path));
    expect(homepageTitle()).not.toBeInTheDocument();
  });

  it('renders nothing while the session is still loading (no homepage flash)', () => {
    const { router } = renderRoutes(routes, { url: '/', auth: fakeAuth({ user: undefined }) });
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'home.signIn' })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('opening / with the real session check (GET /api/auth/me)', () => {
  function openRoot() {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });
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

  const meCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
    fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me').length;

  it('redirects a valid session once, replacing the history entry, with a single session request', async () => {
    const fetchMock = mockFetch((_method, url) =>
      url === '/api/auth/me' ? [200, user('Trainee')] : [200, []],
    );
    const router = openRoot();

    await waitFor(() => expect(router.state.location.pathname).toBe('/trainee'));
    expect(router.state.historyAction).toBe('REPLACE'); // Back does not return to `/` and bounce again
    expect(homepageTitle()).not.toBeInTheDocument();
    expect(meCalls(fetchMock)).toBe(1);
  });

  it('shows the homepage when the session has expired (401), without asking to sign in', async () => {
    const fetchMock = mockFetch(() => [401]);
    const router = openRoot();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('home.titleAccent');
    expect(router.state.location.pathname).toBe('/');
    expect(meCalls(fetchMock)).toBe(1);
  });

  it('shows the homepage when the session cannot be checked (server error)', async () => {
    mockFetch(() => [503, { code: 'api_unavailable' }]);
    const router = openRoot();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('home.titleAccent');
    expect(router.state.location.pathname).toBe('/');
  });
});
