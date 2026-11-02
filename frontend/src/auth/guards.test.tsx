import { screen } from '@testing-library/react';
import { RequireRole, RequireSignedOut } from './guards';
import type { UserRole } from './models';
import { fakeAuth, renderRoutes } from '../test/render';

const user = (role: UserRole) => ({ id: '1', role, email: 'u@company.example', name: null });

function routes(area: UserRole | null, path: string) {
  return [
    {
      path,
      element: (
        <RequireRole role={area}>
          <p>area {area}</p>
        </RequireRole>
      ),
    },
    { path: '/sign-in', element: <p>sign-in page</p> },
    ...(['Admin', 'HR', 'Employee', 'Trainee'] as const).map((r) => ({
      path: `/${r === 'HR' ? 'hr' : r.toLowerCase()}`,
      element: <p>home of {r}</p>,
    })),
  ];
}

describe('route guards', () => {
  it('sends signed-out visitors to the sign-in page with a return URL', async () => {
    const { router } = renderRoutes(routes('Admin', '/admin/fields'), {
      url: '/admin/fields',
      auth: fakeAuth({ user: null }),
    });
    expect(await screen.findByText('sign-in page')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?returnUrl=%2Fadmin%2Ffields');
  });

  it('lets a user into their own role area', async () => {
    renderRoutes(routes('HR', '/hr/x'), { url: '/hr/x', auth: fakeAuth({ user: user('HR') }) });
    expect(await screen.findByText('area HR')).toBeInTheDocument();
  });

  it.each([
    ['Employee', 'Admin', 'Employee'],
    ['Trainee', 'HR', 'Trainee'],
    ['HR', 'Trainee', 'HR'],
    ['Admin', 'Employee', 'Admin'],
  ] as const)('sends a %s away from the %s area to their own', async (role, area, home) => {
    renderRoutes(routes(area, '/area'), { url: '/area', auth: fakeAuth({ user: user(role) }) });
    expect(await screen.findByText(`home of ${home}`)).toBeInTheDocument();
  });

  it.each(['Admin', 'HR', 'Employee', 'Trainee'] as const)(
    'sends an ordinary Google user (no role) away from the %s area to their account page',
    async (area) => {
      renderRoutes([...routes(area, '/area'), { path: '/account', element: <p>account page</p> }], {
        url: '/area',
        auth: fakeAuth({ user: { id: 'google:1', role: null, email: 'u@gmail.com', name: null } }),
      });
      expect(await screen.findByText('account page')).toBeInTheDocument();
    },
  );

  it('keeps staff out of the account page of ordinary Google users', async () => {
    renderRoutes(routes(null, '/account'), {
      url: '/account',
      auth: fakeAuth({ user: user('Employee') }),
    });
    expect(await screen.findByText('home of Employee')).toBeInTheDocument();
  });

  it('waits while the session is loading', () => {
    renderRoutes(routes('Admin', '/area'), { url: '/area', auth: fakeAuth({ user: undefined }) });
    expect(screen.queryByText(/area|sign-in|home/)).not.toBeInTheDocument();
  });

  it('sends a signed-in user from the sign-in page to their area', async () => {
    renderRoutes(
      [
        {
          path: '/sign-in',
          element: (
            <RequireSignedOut>
              <p>form</p>
            </RequireSignedOut>
          ),
        },
        { path: '/trainee', element: <p>trainee home</p> },
      ],
      { url: '/sign-in', auth: fakeAuth({ user: user('Trainee') }) },
    );
    expect(await screen.findByText('trainee home')).toBeInTheDocument();
  });
});
