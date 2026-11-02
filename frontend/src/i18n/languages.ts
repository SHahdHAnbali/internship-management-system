export type Language = 'ar' | 'en';
export type Direction = 'rtl' | 'ltr';

export interface LanguageDefinition {
  readonly code: Language;
  readonly dir: Direction;
  /** Native name, shown in the language switcher. */
  readonly label: string;
}

/** Arabic (RTL) is the default; English (LTR) is the second language. */
export const DEFAULT_LANGUAGE: Language = 'ar';

export const LANGUAGES: Record<Language, LanguageDefinition> = {
  ar: { code: 'ar', dir: 'rtl', label: 'العربية' },
  en: { code: 'en', dir: 'ltr', label: 'English' },
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && value in LANGUAGES;
}
