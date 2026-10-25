import { Direction } from '@angular/cdk/bidi';

export type AppLanguage = 'ar' | 'en';

export interface LanguageDefinition {
  readonly code: AppLanguage;
  readonly dir: Direction;
  /** Native name, shown in the language switcher. */
  readonly label: string;
}

/** Arabic (RTL) is the default; English (LTR) is the second language. */
export const DEFAULT_LANGUAGE: AppLanguage = 'ar';

export const LANGUAGES: Record<AppLanguage, LanguageDefinition> = {
  ar: { code: 'ar', dir: 'rtl', label: 'العربية' },
  en: { code: 'en', dir: 'ltr', label: 'English' },
};

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && value in LANGUAGES;
}
