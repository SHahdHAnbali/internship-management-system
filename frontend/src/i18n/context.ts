import { createContext, useContext } from 'react';
import type { Direction, Language } from './languages';
import type { Params } from './translate';

export interface I18n {
  language: Language;
  dir: Direction;
  t: (key: string, params?: Params) => string;
  setLanguage: (language: Language) => Promise<void>;
}

export const I18nContext = createContext<I18n | null>(null);

export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error('useI18n must be used inside <I18nProvider>.');
  return i18n;
}
