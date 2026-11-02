/**
 * Certificate fonts. The ids mirror the API (backend-workers/src/domain/certificateTemplate.ts: ENGLISH_FONTS,
 * ARABIC_FONTS); all are Google Fonts (SIL Open Font License) used at weights 400 and 700. In every text the English
 * font draws Latin letters and digits and the Arabic font draws Arabic letters (the font stack lists both), so
 * Arabic, English and bilingual certificates each use the chosen pair. Fonts are downloaded only when selected.
 */
export const ENGLISH_FONT_IDS = [
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

export const ARABIC_FONT_IDS = [
  'noto-sans-arabic',
  'ibm-plex-sans-arabic',
  'cairo',
  'tajawal',
  'almarai',
  'noto-naskh-arabic',
  'amiri',
  'reem-kufi',
] as const;

export type EnglishFontId = (typeof ENGLISH_FONT_IDS)[number];
export type ArabicFontId = (typeof ARABIC_FONT_IDS)[number];
export type FontCategory = 'sans' | 'serif' | 'display' | 'naskh' | 'kufi';

export interface CertificateFont {
  /** The CSS / Google Fonts family name. */
  family: string;
  category: FontCategory;
  /** Already loaded by index.html for the whole app. */
  preloaded?: boolean;
}

export const FONTS: Record<EnglishFontId | ArabicFontId, CertificateFont> = {
  inter: { family: 'Inter', category: 'sans', preloaded: true },
  montserrat: { family: 'Montserrat', category: 'sans' },
  poppins: { family: 'Poppins', category: 'sans' },
  'noto-serif': { family: 'Noto Serif', category: 'serif' },
  lora: { family: 'Lora', category: 'serif' },
  merriweather: { family: 'Merriweather', category: 'serif' },
  'libre-baskerville': { family: 'Libre Baskerville', category: 'serif' },
  'eb-garamond': { family: 'EB Garamond', category: 'serif' },
  'cormorant-garamond': { family: 'Cormorant Garamond', category: 'display' },
  'playfair-display': { family: 'Playfair Display', category: 'display' },
  'noto-sans-arabic': { family: 'Noto Sans Arabic', category: 'sans', preloaded: true },
  'ibm-plex-sans-arabic': { family: 'IBM Plex Sans Arabic', category: 'sans' },
  cairo: { family: 'Cairo', category: 'sans' },
  tajawal: { family: 'Tajawal', category: 'sans' },
  almarai: { family: 'Almarai', category: 'sans' },
  'noto-naskh-arabic': { family: 'Noto Naskh Arabic', category: 'naskh' },
  amiri: { family: 'Amiri', category: 'naskh' },
  'reem-kufi': { family: 'Reem Kufi', category: 'kufi' },
};

/** Sample lines for the font previews, in each script. */
export const FONT_SAMPLES = {
  en: 'Certificate of Training Completion',
  ar: 'شهادة إتمام تدريب',
} as const;

/** CSS font-family for an English + Arabic pair: Latin from the English font, Arabic from the Arabic font. */
export function fontStack(pair: { en: EnglishFontId; ar: ArabicFontId }): string {
  const en = FONTS[pair.en];
  const generic = en.category === 'sans' ? 'system-ui, sans-serif' : 'Georgia, serif';
  return `'${en.family}', '${FONTS[pair.ar].family}', ${generic}`;
}

const requested = new Set<string>();

/** Adds the Google Fonts stylesheet of each font not loaded yet (one small stylesheet per family, on demand). */
export function loadFonts(ids: readonly (EnglishFontId | ArabicFontId)[]): void {
  if (typeof document === 'undefined') return;
  for (const id of ids) {
    const font = FONTS[id];
    if (!font || font.preloaded || requested.has(id)) continue;
    requested.add(id);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${font.family.replace(/ /g, '+')}:wght@400;700&display=swap`;
    link.dataset['certificateFont'] = id;
    document.head.appendChild(link);
  }
}
