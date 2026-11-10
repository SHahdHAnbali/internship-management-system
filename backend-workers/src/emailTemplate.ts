/**
 * The HTML layout of IMS e-mails (AD-60): one message holds both languages, Arabic first (right to left), then English
 * (left to right). Inline styles and table layout for mail clients; no external images, fonts, scripts or tracking.
 * Every value is HTML-escaped here, so callers pass plain text. The colours are the IMS design tokens
 * (`frontend/src/styles/_tokens.scss`), written out because mail clients cannot read CSS variables.
 */

/** One language's part of an e-mail, as plain text (escaped when rendered). */
export interface EmailSection {
  heading: string;
  /** Paragraphs before the highlighted code. */
  intro: string[];
  /** A short value shown large, such as a sign-in code. */
  code?: string;
  /** A sentence introducing the button, the button's label and its URL (also shown as text for copying). */
  action?: { lead: string; label: string; url: string };
  /** Paragraphs after the code and button. */
  notes: string[];
}

const COLORS = {
  brand: '#e64d20',
  primary: '#c93d12',
  heading: '#0f1217',
  text: '#474a4d',
  muted: '#6b6f78',
  border: '#e7e7ea',
  subtle: '#fafafb',
  white: '#ffffff',
};

const FONTS = {
  ar: "Tahoma, 'Segoe UI', Arial, sans-serif",
  en: "-apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
};

/** Escapes text for HTML content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only absolute http(s) URLs become links; anything else is shown as text only (never as a `javascript:` link). */
function isLinkable(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url);
}

function paragraph(text: string, align: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:${COLORS.text};text-align:${align};">${escapeHtml(text)}</p>`;
}

function section(content: EmailSection, lang: 'ar' | 'en'): string {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const align = lang === 'ar' ? 'right' : 'left';
  const parts = [
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${COLORS.heading};text-align:${align};">${escapeHtml(content.heading)}</h1>`,
    ...content.intro.map((text) => paragraph(text, align)),
  ];
  if (content.code !== undefined) {
    // The code reads left to right in both languages.
    parts.push(
      `<p dir="ltr" style="margin:0 0 20px;padding:14px 16px;background:${COLORS.subtle};border:1px solid ${COLORS.border};border-radius:10px;text-align:center;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${COLORS.heading};">${escapeHtml(content.code)}</p>`,
    );
  }
  if (content.action && !isLinkable(content.action.url)) {
    parts.push(
      paragraph(content.action.lead, align),
      `<p dir="ltr" style="margin:0 0 20px;font-size:13px;line-height:1.6;color:${COLORS.muted};text-align:${align};word-break:break-all;">${escapeHtml(content.action.url)}</p>`,
    );
  } else if (content.action) {
    const href = escapeHtml(content.action.url);
    parts.push(
      paragraph(content.action.lead, align),
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;"><tr><td style="border-radius:10px;background:${COLORS.primary};"><a href="${href}" style="display:inline-block;padding:12px 24px;font-size:16px;font-weight:700;line-height:1.2;color:${COLORS.white};text-decoration:none;border-radius:10px;">${escapeHtml(content.action.label)}</a></td></tr></table>`,
      `<p dir="ltr" style="margin:0 0 20px;font-size:13px;line-height:1.6;color:${COLORS.muted};text-align:${align};word-break:break-all;"><a href="${href}" style="color:${COLORS.primary};text-decoration:underline;">${href}</a></p>`,
    );
  }
  parts.push(...content.notes.map((text) => paragraph(text, align)));
  return `<div dir="${dir}" lang="${lang}" style="font-family:${FONTS[lang]};text-align:${align};">${parts.join('')}</div>`;
}

/**
 * A complete HTML e-mail: header, the Arabic section, a divider, the English section. `title` is the document title
 * (the subject is a good choice).
 */
export function renderBilingualHtml(title: string, ar: EmailSection, en: EmailSection): string {
  return [
    '<!doctype html>',
    '<html lang="ar" dir="rtl">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    '<meta name="supported-color-schemes" content="light">',
    `<title>${escapeHtml(title)}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;background:${COLORS.subtle};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.subtle};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${COLORS.white};border:1px solid ${COLORS.border};border-radius:16px;">`,
    `<tr><td dir="ltr" style="padding:20px 28px;border-bottom:3px solid ${COLORS.brand};font-family:${FONTS.en};font-size:20px;font-weight:700;color:${COLORS.heading};text-align:center;">ProGineer</td></tr>`,
    `<tr><td style="padding:28px 28px 8px;">${section(ar, 'ar')}</td></tr>`,
    `<tr><td style="padding:0 28px;"><hr style="margin:0;border:0;border-top:1px solid ${COLORS.border};"></td></tr>`,
    `<tr><td style="padding:28px 28px 8px;">${section(en, 'en')}</td></tr>`,
    '</table>',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
}
