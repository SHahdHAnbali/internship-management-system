import { act, render, screen } from '@testing-library/react';
import { useI18n } from './context';
import { I18nProvider } from './I18nProvider';
import { translate } from './translate';

const messages = {
  ar: { app: { title: 'نظام إدارة المتدربين' } },
  en: { app: { title: 'Trainee Management System' } },
};

function Title() {
  const { t, setLanguage } = useI18n();
  return (
    <>
      <h1>{t('app.title')}</h1>
      <button onClick={() => void setLanguage('en')}>en</button>
    </>
  );
}

describe('i18n', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.includes('/en.') ? messages.en : messages.ar)),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to Arabic, right-to-left', async () => {
    render(
      <I18nProvider>
        <Title />
      </I18nProvider>,
    );
    expect(await screen.findByRole('heading')).toHaveTextContent('نظام إدارة المتدربين');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(document.documentElement).toHaveAttribute('lang', 'ar');
  });

  it('switches to English, left-to-right, at runtime and remembers the choice', async () => {
    render(
      <I18nProvider>
        <Title />
      </I18nProvider>,
    );
    await screen.findByRole('heading');
    await act(async () => screen.getByRole('button').click());
    expect(screen.getByRole('heading')).toHaveTextContent('Trainee Management System');
    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(localStorage.getItem('ims.language')).toBe('en');
  });

  it('fills {{params}} and falls back to the key', () => {
    expect(translate({ a: { b: 'valid {{minutes}} min' } }, 'a.b', { minutes: 15 })).toBe(
      'valid 15 min',
    );
    expect(translate({}, 'missing.key')).toBe('missing.key');
  });
});
