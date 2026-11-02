import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../lib/api';
import { fakeAuth, mockFetch, renderRoutes } from '../../test/render';
import { signInErrorKey } from './authErrors';
import { SignInPage } from './SignInPage';

const config = { googleClientId: null, googleHostedDomains: null, traineeCodeLifetimeMinutes: 15 };

function setup(auth = fakeAuth()) {
  mockFetch((_m, url) => (url === '/api/auth/config' ? [200, config] : [404]));
  return renderRoutes(
    [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/trainee', element: <p>trainee area</p> },
    ],
    { url: '/sign-in', auth },
  );
}

describe('SignInPage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers Google as the only external provider and no password field', async () => {
    setup();
    expect(await screen.findByRole('button', { name: /Google/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByText(/Apple|GitHub|SSO/)).not.toBeInTheDocument();
    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(await screen.findByText('auth.staff.notConfigured')).toBeInTheDocument();
  });

  it('signs a trainee in with the e-mailed code and opens the trainee area', async () => {
    const auth = fakeAuth({
      verifyTraineeCode: vi.fn(async () => ({
        id: 't1',
        role: 'Trainee' as const,
        email: 'sara@uni.example',
        name: null,
      })),
    });
    setup(auth);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('auth.trainee.email'), 'sara@uni.example');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.sendCode' }));
    expect(auth.requestTraineeCode).toHaveBeenCalledWith('sara@uni.example');

    await user.type(await screen.findByLabelText('auth.trainee.code'), '123456');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.signIn' }));

    expect(auth.verifyTraineeCode).toHaveBeenCalledWith('sara@uni.example', '123456');
    expect(await screen.findByText('trainee area')).toBeInTheDocument();
  });

  it('validates the e-mail and the 6-digit code before calling the API', async () => {
    const auth = fakeAuth();
    setup(auth);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('auth.trainee.email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.sendCode' }));
    expect(screen.getByText('auth.errors.invalidEmail')).toBeInTheDocument();
    expect(auth.requestTraineeCode).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('auth.trainee.email'));
    await user.type(screen.getByLabelText('auth.trainee.email'), 'a@uni.example');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.sendCode' }));
    await user.type(await screen.findByLabelText('auth.trainee.code'), '12');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.signIn' }));
    expect(screen.getByText('auth.errors.codeFormat')).toBeInTheDocument();
    expect(auth.verifyTraineeCode).not.toHaveBeenCalled();
  });

  it('shows the API error for an expired or wrong code', async () => {
    const auth = fakeAuth({
      verifyTraineeCode: vi.fn(async () =>
        Promise.reject(new ApiError(400, { code: 'auth.invalid_code' })),
      ),
    });
    setup(auth);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('auth.trainee.email'), 'a@uni.example');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.sendCode' }));
    await user.type(await screen.findByLabelText('auth.trainee.code'), '000000');
    await user.click(screen.getByRole('button', { name: 'auth.trainee.signIn' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('auth.errors.invalidCode'),
    );
  });

  it.each([
    [403, { code: 'auth.domain_not_allowed' }, 'auth.errors.domainNotAllowed'],
    [400, { code: 'auth.invalid_code' }, 'auth.errors.invalidCode'],
    [429, null, 'auth.errors.tooManyRequests'],
    [503, { code: 'email.not_configured' }, 'auth.errors.unavailable'],
  ])('maps HTTP %i to a clear message', (status, body, key) => {
    expect(signInErrorKey(new ApiError(status, body))).toBe(key);
  });
});
