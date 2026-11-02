import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { fontStack, loadFonts } from './fonts';
import { SAMPLE_DATA, type CertificateSettings, type LocalizedText, type Option } from './model';

/**
 * Renders a certificate from the template settings at A4 size (96 dpi), scaled to the available width. Colours, fonts
 * and sizes come from the Admin's settings, so they are applied as inline styles. The data shown are the clearly
 * labelled sample values (SAMPLE_DATA): real certificates are issued in a later module. If a combination of settings
 * makes the content taller than the page, it is scaled down to fit, so every valid template prints on one page.
 */
const PAGE = { landscape: { width: 1123, height: 794 }, portrait: { width: 794, height: 1123 } };

const TITLE_SIZE = { small: 30, medium: 38, large: 46 };
const NAME_SIZE = { small: 30, medium: 36, large: 44 };
const BODY_SIZE = { small: 14, medium: 16, large: 18 };
const LOGO_HEIGHT = { small: 44, medium: 60, large: 80 };
const SIGNATURE_HEIGHT = { small: 36, medium: 48, large: 64 };
const QR_SIZE = { small: 64, medium: 80, large: 100 };
const PADDING = { compact: 48, comfortable: 60, spacious: 76 };
const GAP = { compact: 7, comfortable: 11, spacious: 16 };
const BORDER = { thin: 2, medium: 4, thick: 7 };

/** Labels of the PDF §5 data, in the certificate's language (not the app's). */
const LABELS: Record<string, LocalizedText> = {
  university: { ar: 'الجامعة', en: 'University' },
  period: { ar: 'فترة التدريب', en: 'Training period' },
  hours: { ar: 'إجمالي ساعات التدريب', en: 'Total training hours' },
  trainer: { ar: 'المدرّب', en: 'Trainer' },
  grade: { ar: 'التقدير العام', en: 'Overall grade' },
  comment: { ar: 'ملاحظة المدرّب', en: "Trainer's comment" },
  hoursUnit: { ar: 'ساعة', en: 'hours' },
  qrPlaceholder: {
    ar: 'مكان رمز QR (ليس رمز تحقق)',
    en: 'QR code placeholder (not a verification code)',
  },
};

export interface CertificateImages {
  /** Company logo URL (the default ProGineer logo, an uploaded one), or null for none. */
  logo: string | null;
  /** HR signature image URL, or null to show an empty signature line. */
  signature: string | null;
}

/**
 * The certificate scaled to the available width. `settings` null: the saved template has not loaded yet, so a blank
 * page of the usual size stands in with `placeholder` as its text, rather than a design the Admin did not save.
 */
export function CertificatePreview({
  settings,
  images,
  label,
  placeholder,
}: {
  settings: CertificateSettings | null;
  images: CertificateImages;
  label: string;
  placeholder?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const page = PAGE[settings?.layout.orientation ?? 'landscape'];

  // Measured before the first paint (so the page never shows at a provisional size), then kept up to date.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = width > 0 ? Math.min(width / page.width, 1) : 0.3;
  const size = { width: page.width * scale, height: page.height * scale };
  // One host element in both states, so its size is tracked across the switch.
  return (
    <div
      ref={host}
      className="w-full"
      {...(settings ? { role: 'img', 'aria-label': label } : { 'aria-busy': true })}
    >
      {settings ? (
        <div className="mx-auto overflow-hidden shadow-raised" style={size}>
          <div style={{ zoom: scale }}>
            <CertificateView settings={settings} images={images} />
          </div>
        </div>
      ) : (
        <div
          className="mx-auto flex items-center justify-center bg-surface p-4 text-center text-small text-muted shadow-raised"
          style={size}
        >
          {placeholder}
        </div>
      )}
    </div>
  );
}

export function CertificateView({
  settings: s,
  images,
}: {
  settings: CertificateSettings;
  images: CertificateImages;
}) {
  const page = PAGE[s.layout.orientation];
  const primary = s.language === 'en' ? 'en' : 'ar';
  const bilingual = s.language === 'bilingual';
  const centered = s.layout.alignment === 'center';
  const gap = GAP[s.layout.spacing];
  const body = BODY_SIZE[s.typography.bodySize];
  const pad = PADDING[s.layout.spacing] + (s.layout.preset === 'modern' ? 18 : 0);

  const text = (value: LocalizedText, secondaryScale = 0.62): ReactNode =>
    bilingual ? (
      <>
        <span style={{ display: 'block' }}>{value.ar}</span>
        {value.en && (
          <span lang="en" dir="ltr" style={{ display: 'block', fontSize: `${secondaryScale}em` }}>
            {value.en}
          </span>
        )}
      </>
    ) : (
      value[primary]
    );
  const label = (value: LocalizedText): ReactNode =>
    bilingual ? (
      <>
        <span style={{ display: 'block' }}>{value.ar}</span>
        <span lang="en" dir="ltr" style={{ display: 'block' }}>
          {value.en}
        </span>
      </>
    ) : (
      value[primary]
    );
  const { headingFont, bodyFont } = s.typography;
  useEffect(() => {
    // Only the four selected families are downloaded (once each).
    loadFonts([headingFont.en, headingFont.ar, bodyFont.en, bodyFont.ar]);
  }, [headingFont.en, headingFont.ar, bodyFont.en, bodyFont.ar]);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => fitToPage(content.current);
    fit();
    document.fonts?.addEventListener('loadingdone', fit);
    return () => document.fonts?.removeEventListener('loadingdone', fit);
  });
  const data = (value: LocalizedText) => value[primary];

  const period = formatPeriod(primary);
  const details = [
    { key: 'university', value: data(SAMPLE_DATA.university) },
    { key: 'period', value: period },
    { key: 'hours', value: `${SAMPLE_DATA.totalHours} ${data(LABELS.hoursUnit!)}` },
    ...(s.elements.showTrainerName
      ? [{ key: 'trainer', value: data(SAMPLE_DATA.trainerName) }]
      : []),
    { key: 'grade', value: data(SAMPLE_DATA.grade) },
  ];

  const root: CSSProperties = {
    width: page.width,
    height: page.height,
    position: 'relative',
    boxSizing: 'border-box',
    padding: pad,
    overflow: 'hidden',
    background: background(s),
    color: s.colors.text,
    fontFamily: fontStack(s.typography.bodyFont),
    fontSize: body,
    lineHeight: 1.45,
    display: 'flex',
    flexDirection: 'column',
  };
  const column: CSSProperties = {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap,
    textAlign: centered ? 'center' : 'start',
    alignItems: centered ? 'center' : 'stretch',
  };
  const detailColumns =
    s.layout.detailsLayout === 'grid'
      ? Math.min(details.length, s.layout.orientation === 'landscape' ? 5 : 3)
      : 1;

  return (
    <div
      lang={primary}
      dir={primary === 'ar' ? 'rtl' : 'ltr'}
      style={root}
      data-testid="certificate"
    >
      <Frame settings={s} />
      <div ref={content} style={column}>
        {images.logo && (
          <div
            style={{
              display: 'flex',
              width: '100%',
              justifyContent: flexPosition(s.logo.position),
            }}
          >
            <img
              src={images.logo}
              alt=""
              style={{ height: LOGO_HEIGHT[s.logo.size], width: 'auto', maxWidth: 320 }}
            />
          </div>
        )}

        <h2
          style={{
            margin: 0,
            fontFamily: fontStack(s.typography.headingFont),
            fontSize: TITLE_SIZE[s.typography.titleSize],
            fontWeight: 700,
            lineHeight: 1.2,
            color: s.colors.primary,
          }}
        >
          {text(s.text.title, 0.55)}
        </h2>
        <div
          style={{
            width: 120,
            height: 3,
            background: s.colors.secondary,
            alignSelf: centered ? 'center' : 'flex-start',
          }}
        />

        <p style={{ margin: 0 }}>{text(s.text.intro, 0.85)}</p>
        <p
          style={{
            margin: 0,
            fontFamily: fontStack(s.typography.headingFont),
            fontSize: NAME_SIZE[s.typography.nameSize],
            fontWeight: 700,
            lineHeight: 1.2,
            color: s.colors.heading,
          }}
        >
          {data(SAMPLE_DATA.traineeName)}
        </p>
        <p style={{ margin: 0 }}>
          {text(s.text.completion, 0.85)}
          <strong style={{ display: 'block', color: s.colors.primary, fontSize: '1.15em' }}>
            {data(SAMPLE_DATA.field)}
          </strong>
        </p>

        <dl
          style={{
            margin: 0,
            width: '100%',
            display: 'grid',
            gap: s.layout.detailsLayout === 'grid' ? `${gap}px ${gap * 2}px` : gap / 2,
            gridTemplateColumns:
              s.layout.detailsLayout === 'grid'
                ? `repeat(${detailColumns}, minmax(0, 1fr))`
                : '1fr',
          }}
        >
          {details.map((item) => (
            <div
              key={item.key}
              style={
                s.layout.detailsLayout === 'grid'
                  ? {}
                  : { display: 'flex', gap: 8, justifyContent: centered ? 'center' : 'flex-start' }
              }
            >
              <dt style={{ color: s.colors.secondary, fontSize: '0.8em', fontWeight: 600 }}>
                {label(LABELS[item.key]!)}
                {s.layout.detailsLayout === 'list' ? ':' : ''}
              </dt>
              <dd style={{ margin: 0, color: s.colors.heading, fontWeight: 600 }}>{item.value}</dd>
            </div>
          ))}
        </dl>

        <div style={{ width: '100%' }}>
          <div style={{ color: s.colors.secondary, fontSize: '0.8em', fontWeight: 600 }}>
            {label(LABELS.comment!)}
          </div>
          <p style={{ margin: 0, fontStyle: 'italic' }}>“{data(SAMPLE_DATA.trainerComment)}”</p>
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            width: '100%',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            alignItems: 'end',
          }}
        >
          {(['start', 'center', 'end'] as const).map((column) => (
            <div key={column} style={{ display: 'flex', justifyContent: 'center' }}>
              {s.signature.visible && s.signature.position === column && (
                <Signature
                  settings={s}
                  image={images.signature}
                  label={text(s.text.signatureLabel, 0.85)}
                />
              )}
              {s.qrCode.position === column && (
                <QrPlaceholder
                  size={QR_SIZE[s.qrCode.size]}
                  color={s.colors.heading}
                  caption={label(LABELS.qrPlaceholder!)}
                />
              )}
            </div>
          ))}
        </div>

        {(s.text.footer.ar || s.text.footer.en) && (
          <p style={{ margin: 0, fontSize: '0.75em', width: '100%', textAlign: 'center' }}>
            {text(s.text.footer, 0.9)}
          </p>
        )}
      </div>
    </div>
  );
}

function Frame({ settings: s }: { settings: CertificateSettings }) {
  const width = BORDER[s.border.width];
  const band =
    s.layout.preset === 'modern' ? (
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          insetBlock: 0,
          insetInlineStart: 0,
          width: 22,
          background: s.colors.primary,
          borderInlineEnd: `6px solid ${s.colors.secondary}`,
        }}
      />
    ) : null;
  if (s.border.style === 'none') return band;

  const frame: CSSProperties = {
    position: 'absolute',
    inset: 22,
    pointerEvents: 'none',
    border:
      s.border.style === 'line'
        ? `${width}px solid ${s.colors.primary}`
        : `${width + 3}px double ${s.colors.primary}`,
  };
  return (
    <>
      {band}
      <div aria-hidden="true" style={frame} />
      {s.border.style !== 'line' && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 34 + width,
            border: `1px solid ${s.colors.secondary}`,
            pointerEvents: 'none',
          }}
        />
      )}
      {s.border.style === 'ornate' &&
        (['Start-Start', 'Start-End', 'End-Start', 'End-End'] as const).map((corner) => {
          const [block, inline] = corner.split('-') as ['Start' | 'End', 'Start' | 'End'];
          return (
            <div
              key={corner}
              aria-hidden="true"
              style={{
                position: 'absolute',
                [`insetBlock${block}`]: 14,
                [`insetInline${inline}`]: 14,
                width: 26,
                height: 26,
                transform: 'rotate(45deg)',
                background: s.colors.secondary,
                border: `3px solid ${s.colors.background}`,
              }}
            />
          );
        })}
    </>
  );
}

function Signature({
  settings: s,
  image,
  label,
}: {
  settings: CertificateSettings;
  image: string | null;
  label: ReactNode;
}) {
  const height = SIGNATURE_HEIGHT[s.signature.size];
  return (
    <div style={{ textAlign: 'center', minWidth: 200 }}>
      <div style={{ height, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
        {image && <img src={image} alt="" style={{ maxHeight: height, maxWidth: 240 }} />}
      </div>
      <div
        style={{
          borderTop: `1px solid ${s.colors.heading}`,
          marginTop: 6,
          paddingTop: 6,
          fontSize: '0.85em',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** A visual stand-in for the future verification QR code: deliberately not scannable. */
function QrPlaceholder({
  size,
  color,
  caption,
}: {
  size: number;
  color: string;
  caption: ReactNode;
}) {
  const cells = 9;
  const cell = size / cells;
  const finder = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x * cell} y={y * cell} width={cell * 3} height={cell * 3} fill={color} />
      <rect
        x={(x + 0.5) * cell}
        y={(y + 0.5) * cell}
        width={cell * 2}
        height={cell * 2}
        fill="#ffffff"
      />
      <rect x={(x + 1) * cell} y={(y + 1) * cell} width={cell} height={cell} fill={color} />
    </g>
  );
  return (
    <div style={{ textAlign: 'center', width: Math.max(size, 150) }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        style={{ opacity: 0.55 }}
      >
        <rect width={size} height={size} fill="#ffffff" stroke={color} strokeDasharray="4 3" />
        {finder(0, 0)}
        {finder(6, 0)}
        {finder(0, 6)}
        <text
          x={size / 2}
          y={size / 2 + 6}
          textAnchor="middle"
          fontSize={size / 6}
          fontWeight={700}
          fill={color}
        >
          QR
        </text>
      </svg>
      <div style={{ fontSize: 11, lineHeight: 1.3, marginTop: 4 }}>{caption}</div>
    </div>
  );
}

/** Scales the content column down (never up) when it is taller than the page; 1 when it fits. */
function fitToPage(element: HTMLDivElement | null) {
  if (!element) return;
  element.style.transform = '';
  const available = element.clientHeight;
  const needed = element.scrollHeight;
  if (available > 0 && needed > available + 1) {
    element.style.transformOrigin = 'top center';
    element.style.transform = `scale(${Math.max(available / needed, 0.5)})`;
  }
}

function background(s: CertificateSettings): string {
  switch (s.background.style) {
    case 'plain':
      return s.colors.background;
    case 'tinted':
      return `linear-gradient(135deg, color-mix(in srgb, ${s.colors.primary} 9%, ${s.colors.background}) 0%, ${s.colors.background} 55%)`;
    case 'pattern':
      return `radial-gradient(color-mix(in srgb, ${s.colors.secondary} 22%, transparent) 1.2px, transparent 1.4px) 0 0 / 22px 22px, ${s.colors.background}`;
  }
}

function flexPosition(position: Option<'position'>): CSSProperties['justifyContent'] {
  return position === 'start' ? 'flex-start' : position === 'end' ? 'flex-end' : 'center';
}

function formatPeriod(language: 'ar' | 'en'): string {
  const format = new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const from = format.format(new Date(SAMPLE_DATA.periodStart));
  const to = format.format(new Date(SAMPLE_DATA.periodEnd));
  return language === 'ar' ? `من ${from} إلى ${to}` : `${from} – ${to}`;
}
