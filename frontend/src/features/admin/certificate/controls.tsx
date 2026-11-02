import { useEffect, useId, type ReactNode } from 'react';
import {
  ARABIC_FONT_IDS,
  ENGLISH_FONT_IDS,
  FONT_SAMPLES,
  FONTS,
  loadFonts,
  type ArabicFontId,
  type EnglishFontId,
  type FontCategory,
} from './fonts';
import { useI18n } from '../../../i18n/context';
import type { LocalizedText } from './model';

/** Form controls of the certificate editor (native elements + design-system classes, RTL-aware). */

/**
 * A collapsible group of settings; every section starts closed. `disabled`: shown in place, but cannot be opened (the
 * saved template has not loaded yet, so there is nothing to edit).
 */
export function Section({
  title,
  disabled = false,
  children,
}: {
  title: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <details className="ims-card group p-0">
      <summary
        aria-disabled={disabled || undefined}
        onClick={disabled ? (event) => event.preventDefault() : undefined}
        className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-semibold text-heading aria-disabled:cursor-default aria-disabled:text-muted"
      >
        {title}
        <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-5 border-t border-divider px-5 py-5">{children}</div>
    </details>
  );
}

/** A small set of choices as a segmented radio group. */
export function Choice<T extends string>({
  legend,
  value,
  options,
  onChange,
  label,
  disabled = [],
  hint,
  error,
}: {
  legend: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: (value: T) => string;
  disabled?: readonly T[];
  hint?: string;
  error?: string;
}) {
  const name = useId();
  const errorId = `${name}-error`;
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? errorId : undefined}>
      <legend className="ims-label mb-2">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option}
            className={`flex min-h-10 cursor-pointer items-center rounded-control border px-3 text-small font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand ${
              value === option
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border bg-surface text-body hover:bg-surface-subtle'
            } ${disabled.includes(option) ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option}
              checked={value === option}
              disabled={disabled.includes(option)}
              onChange={() => onChange(option)}
            />
            {label(option)}
          </label>
        ))}
      </div>
      {hint && <p className="ims-hint">{hint}</p>}
      {error && (
        <p id={errorId} className="ims-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * A certificate font for one script: the family names (with their style) in a select, and a sample line drawn in the
 * selected font so the Admin can see the style before looking at the certificate. Only the selected font is loaded.
 */
export function FontField<S extends 'en' | 'ar'>({
  label,
  script,
  value,
  categoryLabel,
  onChange,
}: {
  label: string;
  script: S;
  value: S extends 'en' ? EnglishFontId : ArabicFontId;
  categoryLabel: (category: FontCategory) => string;
  onChange: (value: S extends 'en' ? EnglishFontId : ArabicFontId) => void;
}) {
  const id = useId();
  const ids = (script === 'en' ? ENGLISH_FONT_IDS : ARABIC_FONT_IDS) as readonly string[];
  useEffect(() => loadFonts([value]), [value]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small text-muted">
        {label}
      </label>
      <select
        id={id}
        className="ims-input"
        value={value}
        onChange={(e) => onChange(e.target.value as S extends 'en' ? EnglishFontId : ArabicFontId)}
      >
        {ids.map((fontId) => {
          const font = FONTS[fontId as EnglishFontId | ArabicFontId];
          return (
            <option key={fontId} value={fontId}>
              {font.family} — {categoryLabel(font.category)}
            </option>
          );
        })}
      </select>
      <p
        data-testid={`font-sample-${script}`}
        lang={script}
        dir={script === 'ar' ? 'rtl' : 'ltr'}
        className="truncate rounded-control bg-surface-subtle px-3 py-2 text-heading"
        style={{ fontFamily: `'${FONTS[value].family}'`, fontSize: '1.125rem' }}
      >
        {FONT_SAMPLES[script]}
      </p>
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-body">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          className="h-10 w-12 cursor-pointer rounded-control border border-border bg-surface p-1"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
        <input
          aria-label={label}
          className="ims-input w-28 font-mono uppercase"
          dir="ltr"
          value={value}
          maxLength={7}
          onChange={(e) => {
            const next = e.target.value.trim();
            if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase());
          }}
        />
      </div>
    </div>
  );
}

/** One static text in Arabic and/or English (only the languages the certificate uses). */
export function TextPair({
  label,
  hint,
  value,
  max,
  languages,
  errors,
  onChange,
}: {
  label: string;
  hint?: string;
  value: LocalizedText;
  max: number;
  languages: readonly ('ar' | 'en')[];
  errors: Partial<Record<'ar' | 'en', string>>;
  onChange: (value: LocalizedText) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <span className="ims-label">{label}</span>
      {hint && <p className="ims-hint -mt-1">{hint}</p>}
      {languages.map((lang) => {
        const inputId = `${id}-${lang}`;
        const error = errors[lang];
        return (
          <div key={lang} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-small text-muted">
              <label htmlFor={inputId}>{t(`admin.certificate.languages.${lang}`)}</label>
              <span aria-hidden="true">
                {value[lang].trim().length}/{max}
              </span>
            </div>
            <input
              id={inputId}
              className="ims-input"
              dir={lang === 'ar' ? 'rtl' : 'ltr'}
              lang={lang}
              value={value[lang]}
              maxLength={max + 20}
              aria-invalid={!!error}
              aria-describedby={error ? `${inputId}-error` : undefined}
              onChange={(e) => onChange({ ...value, [lang]: e.target.value })}
            />
            {error && (
              <p id={`${inputId}-error`} className="ims-error">
                {t(error, { max })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
