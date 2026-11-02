import { DomainError } from './errors';

/**
 * The certificate template design (PDF §4 "manage the certificate template", §5 certificate content; AD-43).
 *
 * Only presentation settings live here: preset layouts, typography, colours, static texts and the placement of the
 * required elements. The certificate's data — trainee name, training field, university, training period, total hours,
 * trainer name, overall grade, trainer's comment (PDF §5) — are placeholders filled when certificates are issued (a
 * later module); they are never stored in the template. Every value is a fixed choice, a hex colour, a boolean or a
 * bounded text, so any valid template renders a coherent certificate. Unknown keys are rejected.
 */
export const CERTIFICATE_SCHEMA_VERSION = 2;

/**
 * Certificate fonts (all from Google Fonts, SIL Open Font License, weights 400 and 700). English and Arabic are chosen
 * separately: in each text the English font draws Latin letters and digits, the Arabic font draws Arabic letters.
 * The ids are stable: they are stored in saved templates. See docs/certificate-template.md for future PDF rendering.
 */
export const ENGLISH_FONTS = [
  'inter',
  'montserrat',
  'poppins',
  'noto-serif',
  'lora',
  'merriweather',
  'libre-baskerville',
  'eb-garamond',
  'cormorant-garamond',
  'playfair-display',
] as const;
export const ARABIC_FONTS = [
  'noto-sans-arabic',
  'ibm-plex-sans-arabic',
  'cairo',
  'tajawal',
  'almarai',
  'noto-naskh-arabic',
  'amiri',
  'reem-kufi',
] as const;

/** Schema version 1 had three combined English + Arabic choices; they map to the same fonts in version 2. */
const VERSION_1_FONTS = {
  sans: { en: 'inter', ar: 'noto-sans-arabic' },
  serif: { en: 'noto-serif', ar: 'noto-naskh-arabic' },
  elegant: { en: 'cormorant-garamond', ar: 'amiri' },
} as const;

export const CERTIFICATE_OPTIONS = {
  preset: ['classic', 'modern', 'elegant'],
  orientation: ['landscape', 'portrait'],
  alignment: ['center', 'start'],
  spacing: ['compact', 'comfortable', 'spacious'],
  detailsLayout: ['grid', 'list'],
  language: ['ar', 'en', 'bilingual'],
  englishFont: ENGLISH_FONTS,
  arabicFont: ARABIC_FONTS,
  size: ['small', 'medium', 'large'],
  backgroundStyle: ['plain', 'tinted', 'pattern'],
  borderStyle: ['none', 'line', 'double', 'ornate'],
  borderWidth: ['thin', 'medium', 'thick'],
  logoSource: ['default', 'uploaded', 'none'],
  position: ['start', 'center', 'end'],
} as const;

type Option<K extends keyof typeof CERTIFICATE_OPTIONS> = (typeof CERTIFICATE_OPTIONS)[K][number];

/** The English and the Arabic font used together for one kind of text (headings, or body text). */
export interface FontPair {
  en: Option<'englishFont'>;
  ar: Option<'arabicFont'>;
}

export interface LocalizedText {
  ar: string;
  en: string;
}

export interface CertificateSettings {
  schemaVersion: typeof CERTIFICATE_SCHEMA_VERSION;
  layout: {
    preset: Option<'preset'>;
    orientation: Option<'orientation'>;
    alignment: Option<'alignment'>;
    spacing: Option<'spacing'>;
    detailsLayout: Option<'detailsLayout'>;
  };
  /** Which language(s) the certificate is printed in (PDF §9: Arabic and English; the choice is the Admin's). */
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
  /** Placeholder only: the verification QR code is generated with the certificate (later module, PDF §5). */
  qrCode: { size: Option<'size'>; position: Option<'position'> };
  /** Q4 (open): whether the trainer's name appears on the certificate is left to the template. */
  elements: { showTrainerName: boolean };
  text: {
    title: LocalizedText;
    intro: LocalizedText;
    completion: LocalizedText;
    signatureLabel: LocalizedText;
    footer: LocalizedText;
  };
}

/** Text limits (characters) per static text; `required` texts must be filled for the certificate's language(s). */
export const CERTIFICATE_TEXT_LIMITS = {
  title: { max: 80, required: true },
  intro: { max: 200, required: true },
  completion: { max: 200, required: true },
  signatureLabel: { max: 80, required: true },
  footer: { max: 200, required: false },
} as const satisfies Record<keyof CertificateSettings['text'], { max: number; required: boolean }>;

/** A polished starting point: an Admin gets a good certificate without changing anything. */
export const DEFAULT_CERTIFICATE_SETTINGS: CertificateSettings = {
  schemaVersion: CERTIFICATE_SCHEMA_VERSION,
  layout: {
    preset: 'classic',
    orientation: 'landscape',
    alignment: 'center',
    spacing: 'comfortable',
    detailsLayout: 'grid',
  },
  language: 'bilingual',
  typography: {
    headingFont: { en: 'noto-serif', ar: 'noto-naskh-arabic' },
    bodyFont: { en: 'inter', ar: 'noto-sans-arabic' },
    titleSize: 'large',
    nameSize: 'large',
    bodySize: 'medium',
  },
  colors: { primary: '#c93d12', secondary: '#b08d57', heading: '#0f1217', text: '#474a4d', background: '#ffffff' },
  background: { style: 'plain' },
  border: { style: 'double', width: 'medium' },
  logo: { source: 'default', size: 'medium', position: 'center' },
  signature: { visible: true, size: 'medium', position: 'start' },
  qrCode: { size: 'medium', position: 'end' },
  elements: { showTrainerName: true },
  text: {
    title: { ar: 'شهادة إتمام تدريب', en: 'Certificate of Training Completion' },
    intro: { ar: 'تشهد شركة ProGineer Technologies بأنّ', en: 'ProGineer Technologies certifies that' },
    completion: {
      ar: 'قد أتمّ بنجاح البرنامج التدريبي في مجال',
      en: 'has successfully completed the training program in',
    },
    signatureLabel: { ar: 'الموارد البشرية', en: 'Human Resources' },
    footer: { ar: '', en: '' },
  },
};

/**
 * Validates untrusted input as CertificateSettings. Throws DomainError `certificate.invalid_settings` naming the first
 * invalid setting (e.g. `colors.primary`). Settings of schema version 1 (saved before the font catalogue) are upgraded
 * to version 2 with the same fonts, so templates saved earlier keep their look.
 */
export function validateCertificateSettings(input: unknown): CertificateSettings {
  const root = object(input, 'settings', [
    'schemaVersion',
    'layout',
    'language',
    'typography',
    'colors',
    'background',
    'border',
    'logo',
    'signature',
    'qrCode',
    'elements',
    'text',
  ]);
  if (root.schemaVersion !== CERTIFICATE_SCHEMA_VERSION && root.schemaVersion !== 1) {
    invalid('schemaVersion', `must be ${CERTIFICATE_SCHEMA_VERSION}`);
  }

  const layout = object(root.layout, 'layout', ['preset', 'orientation', 'alignment', 'spacing', 'detailsLayout']);
  const typography = object(root.typography, 'typography', [
    'headingFont',
    'bodyFont',
    'titleSize',
    'nameSize',
    'bodySize',
  ]);
  const fonts =
    root.schemaVersion === 1
      ? {
          headingFont: legacyFont(typography.headingFont, 'typography.headingFont'),
          bodyFont: legacyFont(typography.bodyFont, 'typography.bodyFont'),
        }
      : {
          headingFont: fontPair(typography.headingFont, 'typography.headingFont'),
          bodyFont: fontPair(typography.bodyFont, 'typography.bodyFont'),
        };
  const colors = object(root.colors, 'colors', ['primary', 'secondary', 'heading', 'text', 'background']);
  const background = object(root.background, 'background', ['style']);
  const border = object(root.border, 'border', ['style', 'width']);
  const logo = object(root.logo, 'logo', ['source', 'size', 'position']);
  const signature = object(root.signature, 'signature', ['visible', 'size', 'position']);
  const qrCode = object(root.qrCode, 'qrCode', ['size', 'position']);
  const elements = object(root.elements, 'elements', ['showTrainerName']);
  const text = object(root.text, 'text', Object.keys(CERTIFICATE_TEXT_LIMITS));
  const language = choice(root.language, 'language', 'language');

  const settings: CertificateSettings = {
    schemaVersion: CERTIFICATE_SCHEMA_VERSION,
    layout: {
      preset: choice(layout.preset, 'layout.preset', 'preset'),
      orientation: choice(layout.orientation, 'layout.orientation', 'orientation'),
      alignment: choice(layout.alignment, 'layout.alignment', 'alignment'),
      spacing: choice(layout.spacing, 'layout.spacing', 'spacing'),
      detailsLayout: choice(layout.detailsLayout, 'layout.detailsLayout', 'detailsLayout'),
    },
    language,
    typography: {
      headingFont: fonts.headingFont,
      bodyFont: fonts.bodyFont,
      titleSize: choice(typography.titleSize, 'typography.titleSize', 'size'),
      nameSize: choice(typography.nameSize, 'typography.nameSize', 'size'),
      bodySize: choice(typography.bodySize, 'typography.bodySize', 'size'),
    },
    colors: {
      primary: color(colors.primary, 'colors.primary'),
      secondary: color(colors.secondary, 'colors.secondary'),
      heading: color(colors.heading, 'colors.heading'),
      text: color(colors.text, 'colors.text'),
      background: color(colors.background, 'colors.background'),
    },
    background: { style: choice(background.style, 'background.style', 'backgroundStyle') },
    border: {
      style: choice(border.style, 'border.style', 'borderStyle'),
      width: choice(border.width, 'border.width', 'borderWidth'),
    },
    logo: {
      source: choice(logo.source, 'logo.source', 'logoSource'),
      size: choice(logo.size, 'logo.size', 'size'),
      position: choice(logo.position, 'logo.position', 'position'),
    },
    signature: {
      visible: bool(signature.visible, 'signature.visible'),
      size: choice(signature.size, 'signature.size', 'size'),
      position: choice(signature.position, 'signature.position', 'position'),
    },
    qrCode: {
      size: choice(qrCode.size, 'qrCode.size', 'size'),
      position: choice(qrCode.position, 'qrCode.position', 'position'),
    },
    elements: { showTrainerName: bool(elements.showTrainerName, 'elements.showTrainerName') },
    text: Object.fromEntries(
      (Object.keys(CERTIFICATE_TEXT_LIMITS) as (keyof typeof CERTIFICATE_TEXT_LIMITS)[]).map((key) => [
        key,
        localizedText(text[key], `text.${key}`, CERTIFICATE_TEXT_LIMITS[key], language),
      ]),
    ) as unknown as CertificateSettings['text'],
  };

  // The signature and the QR code share the bottom row: they need different places.
  if (settings.signature.visible && settings.signature.position === settings.qrCode.position) {
    invalid('qrCode.position', 'must differ from the signature position');
  }

  return settings;
}

function invalid(path: string, reason: string): never {
  throw new DomainError('certificate.invalid_settings', `Certificate setting '${path}' ${reason}.`);
}

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(path, 'must be an object');
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) invalid(`${path}.${unknown}`, 'is not a known setting');
  return value as Record<string, unknown>;
}

function choice<K extends keyof typeof CERTIFICATE_OPTIONS>(value: unknown, path: string, kind: K): Option<K> {
  const options = CERTIFICATE_OPTIONS[kind] as readonly string[];
  if (typeof value !== 'string' || !options.includes(value)) invalid(path, `must be one of: ${options.join(', ')}`);
  return value as Option<K>;
}

function fontPair(value: unknown, path: string): FontPair {
  const pair = object(value, path, ['en', 'ar']);
  return { en: choice(pair.en, `${path}.en`, 'englishFont'), ar: choice(pair.ar, `${path}.ar`, 'arabicFont') };
}

function legacyFont(value: unknown, path: string): FontPair {
  if (typeof value !== 'string' || !(value in VERSION_1_FONTS)) invalid(path, 'must be one of: sans, serif, elegant');
  return { ...VERSION_1_FONTS[value as keyof typeof VERSION_1_FONTS] };
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be true or false');
  return value;
}

function color(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) invalid(path, 'must be a colour like #1a2b3c');
  return value.toLowerCase();
}

// Control characters and line/paragraph separators are not allowed in certificate texts.
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

function localizedText(
  value: unknown,
  path: string,
  limit: { max: number; required: boolean },
  language: CertificateSettings['language'],
): LocalizedText {
  const texts = object(value, path, ['ar', 'en']);
  const result = { ar: '', en: '' };
  for (const lang of ['ar', 'en'] as const) {
    const raw = texts[lang];
    if (typeof raw !== 'string') invalid(`${path}.${lang}`, 'must be text');
    const trimmed = raw.trim();
    if (trimmed.length > limit.max) invalid(`${path}.${lang}`, `must be at most ${limit.max} characters`);
    if (CONTROL_CHARACTERS.test(trimmed)) invalid(`${path}.${lang}`, 'must not contain control characters');
    const used = language === 'bilingual' || language === lang;
    if (limit.required && used && trimmed === '') invalid(`${path}.${lang}`, 'is required');
    result[lang] = trimmed;
  }

  return result;
}
