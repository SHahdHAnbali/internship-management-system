import { useI18n } from '../i18n/context';
import { LANGUAGES } from '../i18n/languages';

/** Arabic / English switch used in every header. On phones only the *other* language is shown, to keep the gutters. */
export function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return (
    <div className="flex flex-none items-center gap-1">
      {Object.values(LANGUAGES).map((lang) => {
        const current = lang.code === language;
        return (
          <button
            key={lang.code}
            type="button"
            lang={lang.code}
            aria-pressed={current}
            onClick={() => void setLanguage(lang.code)}
            className={`ims-btn-text ${current ? 'bg-primary-soft max-sm:hidden' : 'text-muted hover:text-primary'}`}
          >
            {lang.label}
          </button>
        );
      })}
    </div>
  );
}
