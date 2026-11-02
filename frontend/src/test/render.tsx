import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthContext, type Auth } from '../auth/context';
import { ToastProvider } from '../components/Toast';
import { I18nContext, type I18n } from '../i18n/context';
import { translate, type Messages } from '../i18n/translate';

/** Translator for tests: real look-up when messages are given, otherwise the key itself (like Transloco's testing module). */
export function testI18n(messages: Messages | null = null, language: 'ar' | 'en' = 'ar'): I18n {
  return {
    language,
    dir: language === 'ar' ? 'rtl' : 'ltr',
    t: (key, params) => translate(messages, key, params),
    setLanguage: async () => undefined,
  };
}

export function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    user: null,
    unavailable: false,
    refresh: vi.fn(async () => null),
    signInWithGoogle: vi.fn(),
    requestTraineeCode: vi.fn(async () => undefined),
    verifyTraineeCode: vi.fn(),
    verifyTraineeLink: vi.fn(),
    signOut: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Renders routes in memory with test i18n/auth providers. */
export function renderRoutes(
  routes: RouteObject[],
  {
    url = '/',
    auth = fakeAuth(),
    i18n = testI18n(),
  }: { url?: string; auth?: Auth; i18n?: I18n } = {},
): RenderResult & { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const result = render(
    <I18nContext.Provider value={i18n}>
      <AuthContext.Provider value={auth}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthContext.Provider>
    </I18nContext.Provider>,
  );
  return Object.assign(result, { router });
}

export function renderPage(
  element: ReactNode,
  options?: { url?: string; auth?: Auth; i18n?: I18n },
) {
  return renderRoutes([{ path: '*', element }], options);
}

/** Mocks `fetch` with a handler that receives (method, url, body) and returns [status, body]. */
export function mockFetch(
  handler: (method: string, url: string, body: unknown) => [number, unknown?],
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const [status, payload] = handler(init?.method ?? 'GET', url, body);
    return new Response(payload === undefined ? null : JSON.stringify(payload), {
      status,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
