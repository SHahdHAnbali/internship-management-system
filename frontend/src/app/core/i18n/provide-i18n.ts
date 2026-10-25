import { EnvironmentProviders, inject, isDevMode, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';
import { LanguageService } from './language.service';
import { DEFAULT_LANGUAGE, LANGUAGES } from './languages';
import { TranslocoHttpLoader } from './transloco-http-loader';

export function provideI18n(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideTransloco({
      config: {
        availableLangs: Object.keys(LANGUAGES),
        defaultLang: DEFAULT_LANGUAGE,
        fallbackLang: DEFAULT_LANGUAGE,
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
        missingHandler: { logMissingKey: isDevMode(), useFallbackTranslation: true },
      },
      loader: TranslocoHttpLoader,
    }),
    provideAppInitializer(() => inject(LanguageService).init()),
  ]);
}
