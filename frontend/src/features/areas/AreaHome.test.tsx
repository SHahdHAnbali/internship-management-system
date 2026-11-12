import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import arMessages from '../../../public/i18n/ar.json?raw';
import enMessages from '../../../public/i18n/en.json?raw';
import { fakeAuth, mockFetch, renderRoutes, testI18n } from '../../test/render';
import { AreaHome } from './AreaHome';

/** AD-42 as amended (B3): a role-less Google user is told how to register, and can switch to the e-mail sign-in. */
const roleless = {
  id: 'google:sub-1',
  role: null,
  email: 'new.person@gmail.com',
  name: 'New Person',
};

function setup(language: 'ar' | 'en' | null = null) {
  mockFetch(() => [204]);
  const auth = fakeAuth({ user: roleless });
  const result = renderRoutes(
    [
      { path: '/account', element: <AreaHome area="account" /> },
      { path: '/sign-in', element: <p>sign-in page</p> },
    ],
    {
      url: '/account',
      auth,
      i18n: language
        ? testI18n(JSON.parse(language === 'ar' ? arMessages : enMessages), language)
        : undefined,
    },
  );
  return { auth, ...result };
}

describe('the account page of a Google user without a trainee or staff account', () => {
  it('explains the e-mail registration and opens the e-mail sign-in, ending the Google session', async () => {
    const { auth, router } = setup();
    expect(await screen.findByText('areas.accountNoAccess')).toBeInTheDocument();
    expect(screen.getByText('New Person')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'areas.accountUseEmail' }));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(await screen.findByText('sign-in page')).toBeInTheDocument();
  });

  it.each([
    ['ar', 'تتقدّم للتدريب لأول مرة', 'الدخول بالبريد الإلكتروني'],
    ['en', 'applying for training for the first time', 'Sign in with e-mail'],
  ] as const)('reads in %s', async (language, message, button) => {
    setup(language);
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: button })).toBeInTheDocument();
  });
});
