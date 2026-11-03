import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionUser } from '../../auth/models';
import { fakeAuth, mockFetch, renderPage, renderRoutes } from '../../test/render';
import { adminCache } from './adminCache';
import { AdminLayout, AdminNav } from './AdminLayout';
import { CertificateTemplatePage } from './certificate/CertificateTemplatePage';
import { FieldsPage } from './FieldsPage';
import { adminPreviewSeed } from './preview/adminPreviewData';

/** Admin navigation: no loading bar, immediate revisits with a fresh refresh, a navigation bar that never clips. */
afterEach(() => vi.unstubAllGlobals());

const admin: SessionUser = {
  id: 'admin-1',
  role: 'Admin',
  email: 'a@stu.najah.edu',
  name: 'Admin',
};
const field = (name: string) => ({ id: name, name, description: null, isActive: true });

/** A fetch whose responses are released by hand, to look at the page while a request is in flight. */
function controlledFetch() {
  const pending: ((response: Response) => void)[] = [];
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
  vi.stubGlobal('fetch', fetchMock);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    fetchMock,
    respond: (body: unknown, status = 200) => pending.shift()!(json(body, status)),
  };
}

describe('loading Admin pages', () => {
  it('shows no progress bar while the first request is in flight, then the data', async () => {
    const api = controlledFetch();
    renderPage(<FieldsPage />, { auth: fakeAuth({ user: admin }) });

    expect(screen.getByRole('heading', { name: 'admin.fields.title' })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.fields.empty')).not.toBeInTheDocument(); // not "empty" before the data arrives

    api.respond([field('Backend')]);
    expect(await screen.findByText('Backend')).toBeInTheDocument();
  });

  it('shows the data loaded earlier at once when returning to a page, and still refreshes it', async () => {
    adminCache.set(adminCache.key(admin.id, 'fields'), [field('Backend')]);
    const api = controlledFetch();
    renderPage(<FieldsPage />, { auth: fakeAuth({ user: admin }) });

    expect(screen.getByText('Backend')).toBeInTheDocument(); // immediately, from this session
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(api.fetchMock).toHaveBeenCalledWith('/api/admin/fields', expect.anything());

    api.respond([field('Backend'), field('QA')]); // the fresh list replaces it
    expect(await screen.findByText('QA')).toBeInTheDocument();
  });

  it('never shows data remembered for another signed-in user', () => {
    adminCache.set(adminCache.key('someone-else', 'fields'), [field('Secret')]);
    controlledFetch();
    renderPage(<FieldsPage />, { auth: fakeAuth({ user: admin }) });
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
  });

  it('keeps the shown data but reports the error when a refresh fails', async () => {
    adminCache.set(adminCache.key(admin.id, 'fields'), [field('Backend')]);
    mockFetch(() => [503, { status: 503 }]);
    renderPage(<FieldsPage />, { auth: fakeAuth({ user: admin }) });

    expect(await screen.findByText('admin.errors.generic')).toBeInTheDocument(); // the error toast
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.queryByText('admin.errors.loadFailed')).not.toBeInTheDocument();
  });

  it('shows the load error when the first request fails', async () => {
    mockFetch(() => [500, { status: 500 }]);
    renderPage(<FieldsPage />, { auth: fakeAuth({ user: admin }) });
    expect(await screen.findByText('admin.errors.loadFailed')).toBeInTheDocument();
  });
});

describe('certificate editor refresh', () => {
  const seed = () => adminPreviewSeed().certificateTemplate;

  it('replaces the remembered template with the fresh one when nothing was edited', async () => {
    const remembered = { ...seed(), version: '1' };
    remembered.settings.text.title.en = 'Old title';
    adminCache.set(adminCache.key(admin.id, 'certificate-template'), remembered);
    const fresh = { ...seed(), version: '2' };
    fresh.settings.text.title.en = 'New title';
    const api = controlledFetch();
    renderPage(<CertificateTemplatePage />, { auth: fakeAuth({ user: admin }) });

    expect(within(screen.getByTestId('certificate')).getByText('Old title')).toBeInTheDocument();
    api.respond(fresh);
    expect(
      await within(screen.getByTestId('certificate')).findByText('New title'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the Admin’s edits and reports a conflict when a newer version arrives meanwhile', async () => {
    adminCache.set(adminCache.key(admin.id, 'certificate-template'), { ...seed(), version: '1' });
    const api = controlledFetch();
    renderPage(<CertificateTemplatePage />, { auth: fakeAuth({ user: admin }) });
    const title = screen.getAllByLabelText('admin.certificate.languages.en')[0]!;
    await userEvent.setup().type(title, ' (edited)');

    api.respond({ ...seed(), version: '2' });

    expect(await screen.findByRole('alert')).toHaveTextContent('admin.certificate.errors.conflict');
    expect(title).toHaveValue('Certificate of Training Completion (edited)');
  });
});

describe('Admin navigation bar', () => {
  const links = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ path: `page-${i}`, label: `admin.nav.page${i}` }));

  it('lists every page as a tab that wraps instead of clipping, even with many pages', () => {
    renderRoutes(
      [
        {
          path: '/admin',
          element: <AdminNav links={links(12)} />,
          children: [{ path: '*', element: null }],
        },
      ],
      {
        url: '/admin/page-3',
      },
    );
    const tabs = screen.getAllByRole('list')[0]!;
    expect(tabs).toHaveClass('flex-wrap');
    expect(within(tabs).getAllByRole('link')).toHaveLength(12);
    expect(within(tabs).getByRole('link', { name: 'admin.nav.page3' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('on narrow screens opens a menu of all pages that closes on Escape and after choosing one', async () => {
    const { router } = renderRoutes(
      [
        {
          path: '/admin',
          element: <AdminNav links={links(6)} />,
          children: [{ path: '*', element: null }],
        },
      ],
      { url: '/admin/page-1' },
    );
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: /admin\.nav\.menu.*admin\.nav\.page1/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(within(menu).getAllByRole('link')).toHaveLength(6);
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(button);
    await user.click(
      within(document.getElementById(button.getAttribute('aria-controls')!)!).getByRole('link', {
        name: 'admin.nav.page4',
      }),
    );
    expect(router.state.location.pathname).toBe('/admin/page-4');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('loads the saved certificate template in the background when the Admin area opens, so the editor shows it at once', async () => {
    const template = adminPreviewSeed().certificateTemplate;
    const fetchMock = mockFetch((_method, url) => [
      200,
      url.endsWith('/certificate-template') ? template : [],
    ]);
    const layout = (url: string) =>
      renderRoutes(
        [
          {
            path: '/admin',
            element: <AdminLayout />,
            children: [{ path: '*', element: <p>page</p> }],
          },
        ],
        { url, auth: fakeAuth({ user: admin }) },
      );
    const templateRequests = () =>
      fetchMock.mock.calls.filter(([url]) => url === '/api/admin/certificate-template').length;

    const { unmount } = layout('/admin/fields');
    await waitFor(() =>
      expect(adminCache.get(adminCache.key(admin.id, 'certificate-template'))).toEqual(template),
    );
    expect(templateRequests()).toBe(1);
    unmount();

    // The editor's first visit: the saved template is there before its own (background) refresh answers.
    controlledFetch();
    renderPage(<CertificateTemplatePage />, { auth: fakeAuth({ user: admin }) });
    expect(screen.getByTestId('certificate')).toBeInTheDocument();
    expect(screen.queryByText('admin.certificate.loadingTemplate')).not.toBeInTheDocument();
  });

  it('does not load the template in the background when the Admin area opens on the editor itself', async () => {
    const fetchMock = mockFetch(() => [200, []]);
    renderRoutes(
      [
        {
          path: '/admin',
          element: <AdminLayout />,
          children: [{ path: '*', element: <p>page</p> }],
        },
      ],
      { url: '/admin/certificate', auth: fakeAuth({ user: admin }) },
    );
    await screen.findByText('page');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/admin/certificate-template')).toBe(
      false,
    );
  });

  it('keeps the Admin pages and destinations (the five existing ones plus accepted trainees and reports), and clears remembered data on sign-out', async () => {
    adminCache.set(adminCache.key(admin.id, 'fields'), [field('Backend')]);
    const signOut = vi.fn(async () => undefined);
    renderRoutes(
      [
        {
          path: '/admin',
          element: <AdminLayout />,
          children: [{ path: 'fields', element: <p>fields page</p> }],
        },
        { path: '/', element: <p>home</p> },
      ],
      { url: '/admin/fields', auth: fakeAuth({ user: admin, signOut }) },
    );
    const tabs = screen.getAllByRole('list')[0]!;
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '/admin/fields',
      '/admin/evaluation-criteria',
      '/admin/users',
      '/admin/accepted-trainees',
      '/admin/reports',
      '/admin/settings',
      '/admin/certificate',
    ]);

    await userEvent.setup().click(screen.getByRole('button', { name: 'auth.signOut' }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(adminCache.get(adminCache.key(admin.id, 'fields'))).toBeUndefined();
  });
});
