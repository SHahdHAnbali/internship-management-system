import type { PDFDocument, PDFFont, PDFName, PDFPage, RGB } from 'pdf-lib';
import type { ExportColumn, ExportDocument, ExportSection } from './model';

/**
 * A report as a PDF (A4 landscape), drawn with embedded Noto Sans Arabic / Noto Sans so Arabic letters are joined and
 * right-to-left text is ordered correctly: fontkit (through pdf-lib) shapes Arabic, bidi-js (the Unicode Bidirectional
 * Algorithm) orders mixed Arabic, Latin and digits on each line. Arabic documents are laid out right to left (first
 * column on the right). Long cells wrap; tables continue on new pages with their header repeated.
 */
export interface PdfFonts {
  arabic: ArrayBuffer | Uint8Array;
  arabicBold: ArrayBuffer | Uint8Array;
  latin: ArrayBuffer | Uint8Array;
  latinBold: ArrayBuffer | Uint8Array;
}

/** The fonts, from this site (`public/fonts`, SIL Open Font License). */
export async function loadPdfFonts(fetchImpl: typeof fetch = fetch): Promise<PdfFonts> {
  const load = async (name: string) => {
    const response = await fetchImpl(`/fonts/${name}`);
    if (!response.ok) throw new Error(`Font ${name} could not be loaded.`);
    return response.arrayBuffer();
  };
  const [arabic, arabicBold, latin, latinBold] = await Promise.all([
    load('NotoSansArabic-Regular.ttf'),
    load('NotoSansArabic-Bold.ttf'),
    load('NotoSans-Regular.ttf'),
    load('NotoSans-Bold.ttf'),
  ]);
  return { arabic, arabicBold, latin, latinBold };
}

const PAGE = { width: 841.89, height: 595.28 }; // A4 landscape, points
const MARGIN = 36;
const SIZE = { title: 15, detail: 9, heading: 11, cell: 9, footer: 8 };
const LINE = 1.35; // line height, as a factor of the font size
const PAD = 4; // cell padding
type Rgb = { r: number; g: number; b: number };
const COLOR: Record<'text' | 'muted' | 'border' | 'headerFill', Rgb> = {
  text: { r: 0.1, g: 0.12, b: 0.16 },
  muted: { r: 0.38, g: 0.42, b: 0.48 },
  border: { r: 0.78, g: 0.8, b: 0.84 },
  headerFill: { r: 0.93, g: 0.95, b: 0.97 },
};

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const SPACE = /\s/;
/** Invisible direction marks (e.g. in dates formatted for Arabic): they steer the order, but have no glyph to draw. */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

interface Fonts {
  regular: { arabic: PDFFont; latin: PDFFont };
  bold: { arabic: PDFFont; latin: PDFFont };
}
type Face = Fonts['regular'];
interface Run {
  text: string;
  font: PDFFont;
}

type BidiApi = ReturnType<typeof import('bidi-js').default>;
type PdfLib = typeof import('pdf-lib');

/**
 * pdf-lib draws a string with each glyph's advance width only, which drops the OpenType mark positioning that Noto Sans
 * Arabic uses for the dots of final and isolated letters (ب ي ف …). So each shaped glyph is drawn at the position
 * fontkit computed. `embedder` is pdf-lib's (private, stable in the pinned 1.17.1) wrapper of the fontkit font.
 */
interface FontkitRun {
  glyphs: unknown[];
  positions: { xAdvance: number; xOffset: number; yOffset: number }[];
}
interface Embedder {
  font: { layout(text: string, features?: unknown): FontkitRun; unitsPerEm: number };
  fontFeatures?: unknown;
}
const embedderOf = (font: PDFFont) => (font as unknown as { embedder: Embedder }).embedder;

/**
 * One line of text as drawable pieces from left to right (Unicode Bidirectional Algorithm, rule L2). Each piece is one
 * script: Arabic pieces stay in logical order (the font's shaper joins the letters and lays them out right to left);
 * other pieces inside right-to-left text (punctuation, brackets) are reversed and mirrored here. Direction marks are
 * removed after they have steered the order.
 */
export function visualRuns(
  bidi: BidiApi,
  text: string,
  base: 'rtl' | 'ltr',
): { text: string; arabic: boolean }[] {
  if (!text) return [];
  const embedding = bidi.getEmbeddingLevels(text, base);
  const { levels } = embedding;
  const mirrored = bidi.getMirroredCharactersMap(text, levels);
  const chars = text.split(''); // UTF-16 units, matching the indices of `levels` (Arabic and Latin are single units)
  const isArabic = chars.map((c) => ARABIC.test(c));
  // White space takes the script of its neighbour, so "اسم المتدرب" stays one run.
  for (let i = 0; i < chars.length; i++) {
    if (SPACE.test(chars[i]!))
      isArabic[i] = i > 0 ? isArabic[i - 1]! : chars.some((c) => ARABIC.test(c));
  }

  // Logical runs: same level and same script.
  const logical: { start: number; end: number; level: number; arabic: boolean }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = logical.at(-1);
    if (last && last.level === levels[i] && last.arabic === isArabic[i]) last.end = i;
    else logical.push({ start: i, end: i, level: levels[i]!, arabic: isArabic[i]! });
  }

  // Unicode rule L2: from the highest level down to the lowest odd one, reverse each sequence at that level or above.
  const order = logical.map((_, i) => i);
  const max = Math.max(...logical.map((r) => r.level));
  const minOdd = Math.min(...logical.map((r) => (r.level % 2 ? r.level : r.level + 1)));
  for (let level = max; level >= minOdd; level--) {
    for (let i = 0; i < order.length; ) {
      if (logical[order[i]!]!.level >= level) {
        let j = i;
        while (j < order.length && logical[order[j]!]!.level >= level) j++;
        order.splice(i, j - i, ...order.slice(i, j).reverse());
        i = j;
      } else i++;
    }
  }

  return order
    .map((index) => {
      const run = logical[index]!;
      const slice = chars.slice(run.start, run.end + 1);
      const rtl = run.level % 2 === 1;
      // Arabic: given in logical order; the font's shaper joins the letters and lays them out right to left.
      // Anything else in a right-to-left run (punctuation, brackets): reversed and mirrored here.
      const drawn =
        rtl && !run.arabic
          ? slice
              .map((c, k) => mirrored.get(run.start + k) ?? c)
              .reverse()
              .join('')
          : slice.join('');
      return { text: drawn.replace(BIDI_CONTROL, ''), arabic: run.arabic };
    })
    .filter((run) => run.text !== '');
}

/** Draws text runs in visual order. Everything here works on one line at a time. */
class TextLayout {
  private readonly bidi: BidiApi;
  private readonly base: 'rtl' | 'ltr';
  private readonly lib: PdfLib;
  private readonly fontKeys = new Map<PDFPage, Map<PDFFont, PDFName>>();

  constructor(bidi: BidiApi, base: 'rtl' | 'ltr', lib: PdfLib) {
    this.bidi = bidi;
    this.base = base;
    this.lib = lib;
  }

  /** The width of a run as shaped (same advances as `drawRun`). */
  private runWidth(run: Run, size: number): number {
    const embedder = embedderOf(run.font);
    const { positions } = embedder.font.layout(run.text, embedder.fontFeatures);
    return (positions.reduce((sum, p) => sum + p.xAdvance, 0) * size) / embedder.font.unitsPerEm;
  }

  /** Draws one run glyph by glyph at the positions fontkit computed (marks included); returns its width. */
  private drawRun(page: PDFPage, run: Run, x: number, y: number, size: number, color: RGB): number {
    const {
      beginText,
      endText,
      setFontAndSize,
      setTextMatrix,
      showText,
      setFillingColor,
      PDFHexString,
    } = this.lib;
    const embedder = embedderOf(run.font);
    const { positions } = embedder.font.layout(run.text, embedder.fontFeatures);
    // Registers the glyphs in the font subset and gives their ids, in the same order as `positions`.
    const codes =
      run.font.encodeText(run.text).toString().replace(/[<>]/g, '').match(/.{4}/g) ?? [];
    let pageKeys = this.fontKeys.get(page);
    if (!pageKeys) this.fontKeys.set(page, (pageKeys = new Map()));
    let key = pageKeys.get(run.font);
    if (!key)
      pageKeys.set(run.font, (key = page.node.newFontDictionary(run.font.name, run.font.ref)));

    const scale = size / embedder.font.unitsPerEm;
    let pen = x;
    const ops = [setFillingColor(color)];
    positions.forEach((p, i) => {
      const code = codes[i];
      if (code) {
        ops.push(
          beginText(),
          setFontAndSize(key, size),
          setTextMatrix(1, 0, 0, 1, pen + p.xOffset * scale, y + p.yOffset * scale),
          showText(PDFHexString.of(code)),
          endText(),
        );
      }
      pen += p.xAdvance * scale;
    });
    page.pushOperators(this.lib.pushGraphicsState(), ...ops, this.lib.popGraphicsState());
    return pen - x;
  }

  /** The line's runs from left to right, each ready to be drawn as is. */
  runs(text: string, face: Face): Run[] {
    return visualRuns(this.bidi, text, this.base).map((run) => ({
      text: run.text,
      font: run.arabic ? face.arabic : face.latin,
    }));
  }

  width(text: string, face: Face, size: number): number {
    return this.runs(text, face).reduce((sum, run) => sum + this.runWidth(run, size), 0);
  }

  /** Splits text into lines no wider than `max` (at spaces; a word longer than a line is cut). */
  wrap(text: string, face: Face, size: number, max: number): string[] {
    const lines: string[] = [];
    for (const paragraph of String(text).split(/\r?\n/)) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.width(candidate, face, size) <= max) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = word;
        while (this.width(line, face, size) > max && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && this.width(line.slice(0, cut), face, size) > max) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /** Draws one line between `left` and `right`, aligned to the start of the text direction (or centred). */
  draw(
    page: PDFPage,
    text: string,
    face: Face,
    size: number,
    y: number,
    left: number,
    right: number,
    color: RGB,
    align: 'start' | 'center' = 'start',
  ) {
    const runs = this.runs(text, face);
    const total = runs.reduce((sum, run) => sum + this.runWidth(run, size), 0);
    let x =
      align === 'center'
        ? left + (right - left - total) / 2
        : this.base === 'rtl'
          ? right - total
          : left;
    for (const run of runs) x += this.drawRun(page, run, x, y, size, color);
  }
}

/** The report as PDF bytes. */
export async function buildPdf(doc: ExportDocument, fontBytes: PdfFonts): Promise<Uint8Array> {
  const [lib, { default: fontkit }, { default: bidiFactory }] = await Promise.all([
    import('pdf-lib'),
    import('@pdf-lib/fontkit'),
    import('bidi-js'),
  ]);
  const { PDFDocument: Pdf, rgb } = lib;
  const pdf: PDFDocument = await Pdf.create();
  pdf.registerFontkit(fontkit);
  const embed = (bytes: ArrayBuffer | Uint8Array) => pdf.embedFont(bytes, { subset: true });
  const fonts: Fonts = {
    regular: { arabic: await embed(fontBytes.arabic), latin: await embed(fontBytes.latin) },
    bold: { arabic: await embed(fontBytes.arabicBold), latin: await embed(fontBytes.latinBold) },
  };
  const color = (c: Rgb) => rgb(c.r, c.g, c.b);
  const layout = new TextLayout(bidiFactory(), doc.direction, lib);
  const left = MARGIN;
  const right = PAGE.width - MARGIN;
  const bottom = MARGIN + SIZE.footer * 2;

  pdf.setTitle(doc.title);
  pdf.setLanguage(doc.language);
  pdf.setCreator('ProGineer IMS');
  pdf.setProducer('ProGineer IMS');

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };
  const textLine = (text: string, face: Face, size: number, tone: Rgb) => {
    for (const line of layout.wrap(text, face, size, right - left)) {
      if (y - size * LINE < bottom) newPage();
      y -= size * LINE;
      layout.draw(page, line, face, size, y + size * 0.25, left, right, color(tone));
    }
  };

  textLine(doc.title, fonts.bold, SIZE.title, COLOR.text);
  y -= 2;
  for (const line of doc.details) textLine(line, fonts.regular, SIZE.detail, COLOR.muted);
  textLine(doc.generated, fonts.regular, SIZE.detail, COLOR.muted);

  for (const section of doc.sections) {
    y -= 12;
    if (section.heading) textLine(section.heading, fonts.bold, SIZE.heading, COLOR.text);
    y -= 4;
    if (section.rows.length === 0) {
      textLine(section.empty, fonts.regular, SIZE.cell, COLOR.muted);
      continue;
    }
    drawTable(section);
  }

  function columnEdges(columns: ExportColumn[]): { left: number; right: number }[] {
    const total = columns.reduce((sum, c) => sum + (c.width ?? 1), 0);
    let at = 0;
    return columns.map((c) => {
      const width = ((right - left) * (c.width ?? 1)) / total;
      const start = at;
      at += width;
      // Right to left: the first column is on the right.
      return doc.direction === 'rtl'
        ? { left: right - start - width, right: right - start }
        : { left: left + start, right: left + start + width };
    });
  }

  function drawTable(section: ExportSection) {
    const edges = columnEdges(section.columns);
    const lineHeight = SIZE.cell * LINE;
    const cellLines = (cells: (string | number)[], face: Face) =>
      cells.map((value, i) =>
        layout.wrap(
          String(value ?? ''),
          face,
          SIZE.cell,
          edges[i]!.right - edges[i]!.left - PAD * 2,
        ),
      );
    const header = cellLines(
      section.columns.map((c) => c.label),
      fonts.bold,
    );
    const rowHeight = (lines: string[][]) =>
      Math.max(...lines.map((l) => l.length)) * lineHeight + PAD * 2;

    const drawRow = (lines: string[][], face: Face, fill: boolean) => {
      const height = rowHeight(lines);
      const top = y;
      if (fill) {
        page.drawRectangle({
          x: left,
          y: top - height,
          width: right - left,
          height,
          color: color(COLOR.headerFill),
        });
      }
      lines.forEach((cell, i) => {
        const edge = edges[i]!;
        page.drawRectangle({
          x: edge.left,
          y: top - height,
          width: edge.right - edge.left,
          height,
          borderColor: color(COLOR.border),
          borderWidth: 0.5,
        });
        cell.forEach((line, k) => {
          const baseline = top - PAD - (k + 1) * lineHeight + SIZE.cell * 0.3;
          const align = section.columns[i]?.numeric ? 'center' : 'start';
          layout.draw(
            page,
            line,
            face,
            SIZE.cell,
            baseline,
            edge.left + PAD,
            edge.right - PAD,
            color(COLOR.text),
            align,
          );
        });
      });
      y = top - height;
    };

    if (y - rowHeight(header) - lineHeight * 2 < bottom) newPage();
    drawRow(header, fonts.bold, true);
    for (const row of section.rows) {
      const lines = cellLines(row, fonts.regular);
      if (y - rowHeight(lines) < bottom) {
        newPage();
        drawRow(header, fonts.bold, true); // the header again on every page
      }
      drawRow(lines, fonts.regular, false);
    }
  }

  // Page numbers.
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    layout.draw(
      p,
      `${i + 1} / ${pages.length}`,
      fonts.regular,
      SIZE.footer,
      MARGIN / 2,
      left,
      right,
      color(COLOR.muted),
      'center',
    );
  });

  return pdf.save();
}
