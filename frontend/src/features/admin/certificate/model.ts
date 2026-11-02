import { ARABIC_FONT_IDS, ENGLISH_FONT_IDS, type ArabicFontId, type EnglishFontId } from './fonts';

/**
 * Certificate template settings. Mirrors the API contract in backend-workers/src/domain/certificateTemplate.ts (AD-43):
 * only presentation settings; the certificate's data (PDF §5) are placeholders filled when certificates are issued.
 */
export const CERTIFICATE_OPTIONS = {
  preset: ['classic', 'modern', 'elegant'],
  orientation: ['landscape', 'portrait'],
  alignment: ['center', 'start'],
  spacing: ['compact', 'comfortable', 'spacious'],
  detailsLayout: ['grid', 'list'],
  language: ['ar', 'en', 'bilingual'],
  englishFont: ENGLISH_FONT_IDS,
  arabicFont: ARABIC_FONT_IDS,
  size: ['small', 'medium', 'large'],
  backgroundStyle: ['plain', 'tinted', 'pattern'],
  borderStyle: ['none', 'line', 'double', 'ornate'],
  borderWidth: ['thin', 'medium', 'thick'],
  logoSource: ['default', 'uploaded', 'none'],
  position: ['start', 'center', 'end'],
} as const;

export type Option<K extends keyof typeof CERTIFICATE_OPTIONS> =
  (typeof CERTIFICATE_OPTIONS)[K][number];

/** The English and the Arabic font used together for one kind of text. */
export interface FontPair {
  en: EnglishFontId;
  ar: ArabicFontId;
}

export interface LocalizedText {
  ar: string;
  en: string;
}

export interface CertificateSettings {
  schemaVersion: 2;
  layout: {
    preset: Option<'preset'>;
    orientation: Option<'orientation'>;
    alignment: Option<'alignment'>;
    spacing: Option<'spacing'>;
    detailsLayout: Option<'detailsLayout'>;
  };
  language: Option<'language'>;
  typography: {
    headingFont: FontPair;
    bodyFont: FontPair;
    titleSize: Option<'size'>;
    nameSize: Option<'size'>;
    bodySize: Option<'size'>;
  };
  colors: { primary: string; secondary: string; heading: string; text: string; background: string };
  background: { style: Option<'backgroundStyle'> };
  border: { style: Option<'borderStyle'>; width: Option<'borderWidth'> };
  logo: { source: Option<'logoSource'>; size: Option<'size'>; position: Option<'position'> };
  signature: { visible: boolean; size: Option<'size'>; position: Option<'position'> };
  qrCode: { size: Option<'size'>; position: Option<'position'> };
  elements: { showTrainerName: boolean };
  text: Record<CertificateTextKey, LocalizedText>;
}

export type CertificateTextKey = 'title' | 'intro' | 'completion' | 'signatureLabel' | 'footer';

/** Same limits as the API; required texts must be filled for the language(s) the certificate uses. */
export const TEXT_LIMITS: Record<CertificateTextKey, { max: number; required: boolean }> = {
  title: { max: 80, required: true },
  intro: { max: 200, required: true },
  completion: { max: 200, required: true },
  signatureLabel: { max: 80, required: true },
  footer: { max: 200, required: false },
};

export type CertificateImageKind = 'logo' | 'signature';

/** `GET/PUT /api/admin/certificate-template`. */
export interface CertificateTemplate {
  settings: CertificateSettings;
  defaultSettings: CertificateSettings;
  isDefault: boolean;
  version: string | null;
  updatedAt: string | null;
  logo: { contentType: string } | null;
  signature: { contentType: string } | null;
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const IMAGE_MAX_BYTES = 512 * 1024;

/** Recommended styling applied when the Admin picks a preset (they can still change each setting afterwards). */
export const PRESET_STYLES: Record<
  Option<'preset'>,
  (s: CertificateSettings) => CertificateSettings
> = {
  classic: (s) => ({
    ...s,
    layout: { ...s.layout, preset: 'classic', alignment: 'center', detailsLayout: 'grid' },
    typography: {
      ...s.typography,
      headingFont: { en: 'noto-serif', ar: 'noto-naskh-arabic' },
      bodyFont: { en: 'inter', ar: 'noto-sans-arabic' },
    },
    background: { style: 'plain' },
    border: { style: 'double', width: 'medium' },
  }),
  modern: (s) => ({
    ...s,
    layout: { ...s.layout, preset: 'modern', alignment: 'start', detailsLayout: 'grid' },
    typography: {
      ...s.typography,
      headingFont: { en: 'inter', ar: 'noto-sans-arabic' },
      bodyFont: { en: 'inter', ar: 'noto-sans-arabic' },
    },
    background: { style: 'tinted' },
    border: { style: 'none', width: 'thin' },
  }),
  elegant: (s) => ({
    ...s,
    layout: { ...s.layout, preset: 'elegant', alignment: 'center', detailsLayout: 'list' },
    typography: {
      ...s.typography,
      headingFont: { en: 'cormorant-garamond', ar: 'amiri' },
      bodyFont: { en: 'noto-serif', ar: 'noto-naskh-arabic' },
    },
    background: { style: 'pattern' },
    border: { style: 'ornate', width: 'medium' },
  }),
};

/** Client-side checks matching the API, so the Admin sees problems before saving. Returns translation keys. */
export function validateSettings(
  settings: CertificateSettings,
  images: { logo: boolean },
): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  for (const key of Object.keys(TEXT_LIMITS) as CertificateTextKey[]) {
    for (const lang of ['ar', 'en'] as const) {
      const value = settings.text[key][lang].trim();
      const used = settings.language === 'bilingual' || settings.language === lang;
      if (value.length > TEXT_LIMITS[key].max)
        errors[`text.${key}.${lang}`] = 'admin.certificate.errors.tooLong';
      else if (TEXT_LIMITS[key].required && used && !value)
        errors[`text.${key}.${lang}`] = 'admin.validation.required';
    }
  }

  if (settings.signature.visible && settings.signature.position === settings.qrCode.position) {
    errors['qrCode.position'] = 'admin.certificate.errors.samePosition';
  }

  if (settings.logo.source === 'uploaded' && !images.logo) {
    errors['logo.source'] = 'admin.certificate.errors.logoMissing';
  }

  return errors;
}

/**
 * Clearly fictional values shown only in the preview, in place of the PDF §5 placeholders (trainee name, field,
 * university, period, hours, trainer, overall grade, trainer's comment). Never saved with the template.
 */
export const SAMPLE_DATA = {
  traineeName: { ar: 'اسم المتدرّب (نموذج)', en: 'Trainee Name (sample)' },
  field: { ar: 'تطوير الويب (نموذج)', en: 'Web Development (sample)' },
  university: { ar: 'اسم الجامعة (نموذج)', en: 'University Name (sample)' },
  periodStart: '2026-07-01',
  periodEnd: '2026-08-31',
  totalHours: 240,
  trainerName: { ar: 'اسم المدرّب (نموذج)', en: 'Trainer Name (sample)' },
  grade: { ar: 'ممتاز (نموذج)', en: 'Excellent (sample)' },
  trainerComment: {
    ar: 'ملاحظة المدرّب تظهر هنا (نص تجريبي).',
    en: "The trainer's comment appears here (sample text).",
  },
} as const;
