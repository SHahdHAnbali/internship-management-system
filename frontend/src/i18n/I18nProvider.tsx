import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nContext, type I18n } from './context';
import { DEFAULT_LANGUAGE, LANGUAGES, isLanguage, type Language } from './languages';
import { translate, type Messages } from './translate';

const STORAGE_KEY = 'ims.language';

const cache = new Map<Language, Promise<Messages>>();

function loadMessages(language: Language): Promise<Messages> {
  if (!cache.has(language)) {
    const request = fetch(`/i18n/${language}.json`).then((response) => {
      if (!response.ok) throw new Error(`Translations for ${language} could not be loaded.`);
      return response.json() as Promise<Messages>;
    });
    request.catch(() => cache.delete(language));
    cache.set(language, request);
  }

  return cache.get(language)!;
}

/** Loads a language and applies it to the document (`<html lang dir>`) and to the saved preference. */
async function activate(language: Language): Promise<{ language: Language; messages: Messages }> {
  const messages = await loadMessages(language);
  document.documentElement.lang = language;
  document.documentElement.dir = LANGUAGES[language].dir;
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage unavailable (private mode): the choice lasts for this visit only.
  }

  return { language, messages };
}

function readSavedLanguage(): Language | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isLanguage(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Runtime Arabic/English switch (translations from public/i18n/<lang>.json). Changing the language also sets
 * `<html lang dir>`, so the whole UI flips between RTL and LTR. The choice is remembered per browser.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ language: Language; messages: Messages } | null>(null);

  const setLanguage = useCallback(async (language: Language) => {
    setState(await activate(language));
  }, []);

  useEffect(() => {
    const initial = readSavedLanguage() ?? DEFAULT_LANGUAGE;
    activate(initial)
      .catch(() => activate(DEFAULT_LANGUAGE))
      .then(setState, () => undefined);
  }, []);

  const value = useMemo<I18n | null>(
    () =>
      state && {
        language: state.language,
        dir: LANGUAGES[state.language].dir,
        t: (key, params) => translate(state.messages, key, params),
        setLanguage,
      },
    [state, setLanguage],
  );

  // Render nothing until the first translations are loaded, to avoid a flash of raw keys.
  return value ? <I18nContext.Provider value={value}>{children}</I18nContext.Provider> : null;
}
