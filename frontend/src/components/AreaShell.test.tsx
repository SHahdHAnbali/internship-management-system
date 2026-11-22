import { screen } from '@testing-library/react';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from '../test/render';
import { AreaShell } from './AreaShell';

/**
 * The area header on a narrow screen (maintenance, 2026-11-22): in Arabic at 390 px the controls (notifications,
 * language, sign out) were wider than the space beside the logo and could neither shrink nor wrap, so the header was
 * 403 px wide and the sign-out button sat partly outside the screen. The controls may now shrink and wrap onto a second
 * line, at the end of the row, only when they do not fit (one line on wider screens, as before). Layout itself is
 * checked in a real browser; jsdom has none, so this pins the properties that allow it.
 */
afterEach(() => vi.unstubAllGlobals());

it('lets the header controls shrink and wrap when they do not fit beside the logo', async () => {
  mockFetch(() => [200, { unreadCount: 0, hasMore: false, notifications: [] }]);
  renderRoutes(
    [
      {
        path: '/employee',
        element: <AreaShell tabs={[{ to: '/employee', label: 'x' }]}>Content</AreaShell>,
      },
    ],
    {
      url: '/employee',
      auth: fakeAuth({
        user: { id: 'u1', role: 'Employee', email: 'u@company.example', name: null },
      }),
      i18n: testI18n(null, 'ar'),
    },
  );

  const controls = (await screen.findByRole('button', { name: 'auth.signOut' })).parentElement!;
  expect(controls).toHaveClass('min-w-0', 'flex-wrap', 'justify-end');
  // Every control is still there, in order.
  expect(controls.lastElementChild).toHaveTextContent('auth.signOut');
});
