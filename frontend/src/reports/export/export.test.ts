// @vitest-environment node
import bidiFactory from 'bidi-js';
import { unzlibSync, unzipSync, strFromU8 } from 'fflate';
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib';
import arabicBoldUrl from '../../../public/fonts/NotoSansArabic-Bold.ttf?inline';
import arabicUrl from '../../../public/fonts/NotoSansArabic-Regular.ttf?inline';
import latinBoldUrl from '../../../public/fonts/NotoSans-Bold.ttf?inline';
import latinUrl from '../../../public/fonts/NotoSans-Regular.ttf?inline';
import { buildXlsx } from './excel';
import { fileDate } from './files';
import { fileNamePart, type ExportDocument } from './model';
import { buildPdf, loadPdfFonts, visualRuns, type PdfFonts } from './pdf';

/**
 * Report export (PDF §6 «ويُصدَّر Excel أو PDF»): the files themselves. Excel is checked by unzipping the workbook, the
 * PDF by parsing it back with pdf-lib and reading the fonts' Unicode maps. Synthetic data only.
 */
/** The same font files the site serves (`public/fonts`), inlined by Vite as data URLs. */
const fontFile = (dataUrl: string) =>
  Uint8Array.from(atob(dataUrl.split(',')[1]!), (c) => c.charCodeAt(0));
const fonts: PdfFonts = {
  arabic: fontFile(arabicUrl),
  arabicBold: fontFile(arabicBoldUrl),
  latin: fontFile(latinUrl),
  latinBold: fontFile(latinBoldUrl),
};

const arabic: ExportDocument = {
  title: 'التقرير الشهري',
  details: ['الشهر: فبراير 2031', 'المجال: كل المجالات'],
  generated: 'تاريخ التصدير: 4‏/11‏/2026',
  direction: 'rtl',
  language: 'ar',
  fileName: 'ims-monthly-report-2031-02',
  sections: [
    {
      columns: [
        { label: 'المتدرب', width: 2 },
        { label: 'الموظف', width: 2 },
        { label: 'المجال' },
        { label: 'من' },
        { label: 'إلى' },
      ],
      rows: [
        ['متدربة تجريبية', 'موظف تجريبي', 'QA', '1‏/2‏/2031', '14‏/2‏/2031'],
        ['Synthetic Trainee', 'Mentor One (QA)', 'Backend', '15/2/2031', '30/4/2031'],
      ],
      empty: 'لا يوجد',
    },
  ],
};

const counts: ExportDocument = {
  title: 'Fields report',
  details: ['Field: All fields'],
  generated: 'Exported on 11/4/2026',
  direction: 'ltr',
  language: 'en',
  fileName: 'ims-fields-report-2026-11-04',
  sections: [
    {
      columns: [
        { label: 'Field', width: 3 },
        { label: 'Applications', numeric: true },
        { label: 'Accepted', numeric: true },
      ],
      rows: [
        ['Backend', 5, 2],
        ['QA', 1, 0],
      ],
      empty: 'No fields yet.',
    },
  ],
};

async function unzip(blob: Blob): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, strFromU8(bytes)]));
}
const sheetXml = (files: Record<string, string>, n = 1) => files[`xl/worksheets/sheet${n}.xml`]!;
const allText = (files: Record<string, string>) => Object.values(files).join('\n');

describe('Excel export', () => {
  it('writes a valid workbook, right to left for Arabic, with the title, filters, header and every row', async () => {
    const files = await unzip(await buildXlsx(arabic));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'xl/workbook.xml',
        'xl/worksheets/sheet1.xml',
      ]),
    );
    expect(sheetXml(files)).toMatch(/rightToLeft="(1|true)"/);
    const text = allText(files);
    for (const value of [
      'التقرير الشهري',
      'الشهر: فبراير 2031',
      'المتدرب',
      'إلى',
      'متدربة تجريبية',
      'Synthetic Trainee',
      'Mentor One (QA)',
    ]) {
      expect(text).toContain(value);
    }
    expect(files['xl/workbook.xml']).toContain('name="التقرير الشهري"');
  });

  it('writes counts as numbers and left to right for English', async () => {
    const files = await unzip(await buildXlsx(counts));
    expect(sheetXml(files)).not.toMatch(/rightToLeft="(1|true)"/);
    // Numeric cells carry the number itself (no shared-string type).
    expect(sheetXml(files)).toMatch(/<c r="B\d+"[^>]*>\s*<v>5<\/v>/);
    expect(sheetXml(files)).toMatch(/<c r="C\d+"[^>]*>\s*<v>2<\/v>/);
  });

  it('gives each section its own sheet with a safe, unique name, and says when a section is empty', async () => {
    const files = await unzip(
      await buildXlsx({
        ...counts,
        sections: [
          {
            heading: 'Trainings: current/previous [all]',
            columns: counts.sections[0]!.columns,
            rows: [],
            empty: 'No training recorded.',
          },
          {
            heading: 'Trainings: current/previous [all]',
            columns: counts.sections[0]!.columns,
            rows: [['QA', 1, 1]],
            empty: '',
          },
        ],
      }),
    );
    const names = [...files['xl/workbook.xml']!.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name!.length).toBeLessThanOrEqual(31);
      expect(name).not.toMatch(/[[\]:*?/\\]/);
    }
    expect(allText(files)).toContain('No training recorded.');
  });
});

/** Every Unicode code point the PDF's fonts map glyphs to (their ToUnicode CMaps). */
async function mappedCharacters(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  let chars = '';
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const ref = object.get(PDFName.of('ToUnicode'));
    const toUnicode = ref ? pdf.context.lookup(ref) : undefined;
    if (!(toUnicode instanceof PDFRawStream)) continue;
    const cmap = strFromU8(unzlibSync(toUnicode.getContents()));
    for (const [, hex] of cmap.matchAll(/<[0-9a-fA-F]+>\s*<([0-9a-fA-F]{4,})>/g)) {
      for (let i = 0; i < hex!.length; i += 4)
        chars += String.fromCharCode(parseInt(hex!.slice(i, i + 4), 16));
    }
  }
  return chars;
}

describe('PDF export', () => {
  it('is a valid PDF with the Arabic and Latin fonts embedded and the Arabic text mapped to Unicode', async () => {
    const bytes = await buildPdf(arabic, fonts);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('التقرير الشهري');
    const [width, height] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
    expect(width).toBeGreaterThan(height); // A4 landscape

    const baseFonts: string[] = [];
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Font')) {
        baseFonts.push(String(object.get(PDFName.of('BaseFont'))));
      }
    }
    expect(baseFonts.some((name) => /NotoSansArabic-Regular/.test(name))).toBe(true);
    expect(baseFonts.some((name) => /NotoSansArabic-Bold/.test(name))).toBe(true);
    expect(baseFonts.some((name) => /NotoSans-Regular/.test(name))).toBe(true);
    const mapped = await mappedCharacters(bytes);
    // Letters the font draws as one glyph. (Letters it builds from a base and a mark, such as «إ», map back to their
    // base letter only: copying text out of the PDF can lose the hamza. The drawing itself is correct.)
    for (const ch of 'التقريرالشهريمتدربةتجريبيةموظف') expect(mapped).toContain(ch);
    for (const ch of 'SyntheticMentorOneQA') expect(mapped).toContain(ch);
  });

  it('continues long tables on new pages', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => [`Field ${i}`, i, i % 3]);
    const bytes = await buildPdf(
      { ...counts, sections: [{ ...counts.sections[0]!, rows }] },
      fonts,
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });

  it('writes the empty message when a section has no rows', async () => {
    const bytes = await buildPdf(
      { ...counts, sections: [{ ...counts.sections[0]!, rows: [] }] },
      fonts,
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const mapped = await mappedCharacters(bytes);
    for (const ch of 'Nofieldsyet') expect(mapped).toContain(ch);
  });

  it('loads its fonts from this site only', async () => {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      return new Response(new Uint8Array([1]));
    }) as unknown as typeof fetch;
    await loadPdfFonts(fake);
    expect(asked.sort()).toEqual([
      '/fonts/NotoSans-Bold.ttf',
      '/fonts/NotoSans-Regular.ttf',
      '/fonts/NotoSansArabic-Bold.ttf',
      '/fonts/NotoSansArabic-Regular.ttf',
    ]);
  });
});

describe('right-to-left text order (Unicode Bidirectional Algorithm)', () => {
  const bidi = bidiFactory();
  const order = (text: string, base: 'rtl' | 'ltr') => visualRuns(bidi, text, base);

  it('keeps an Arabic phrase in logical order for the shaper, and places brackets and Latin text correctly', () => {
    expect(order('كل المجالات (QA)', 'rtl')).toEqual([
      { text: '(', arabic: false },
      { text: 'QA', arabic: false },
      { text: ')', arabic: false },
      { text: 'كل المجالات ', arabic: true },
    ]);
  });

  it('puts numbers after Arabic words where they belong, read right to left', () => {
    // Drawn left to right: "2031", "فبراير ", " :", "الشهر"; read right to left: «الشهر: فبراير 2031».
    expect(order('الشهر: فبراير 2031', 'rtl')).toEqual([
      { text: '2031', arabic: false },
      { text: 'فبراير ', arabic: true },
      { text: ' :', arabic: false },
      { text: 'الشهر', arabic: true },
    ]);
  });

  it('removes invisible direction marks after using them (dates formatted for Arabic)', () => {
    const runs = order('1‏/2‏/2031', 'rtl');
    expect(runs.map((r) => r.text).join('')).toBe('2031/2/1');
    expect(runs.some((r) => /[‎‏]/.test(r.text))).toBe(false);
  });

  it('leaves English text and Latin names in an English document as one left-to-right piece', () => {
    expect(order('Mentor One (QA)', 'ltr')).toEqual([{ text: 'Mentor One (QA)', arabic: false }]);
  });

  it('orders an Arabic name inside an English document right to left', () => {
    expect(order('Mentor: محمد خليل', 'ltr')).toEqual([
      { text: 'Mentor: ', arabic: false },
      { text: 'محمد خليل', arabic: true },
    ]);
  });
});

describe('file names', () => {
  it('are descriptive and safe', () => {
    expect(fileNamePart('Lina Haddad / QA')).toBe('Lina-Haddad-QA');
    expect(fileNamePart('لينا حداد')).toBe('لينا-حداد');
    expect(fileDate(new Date(2026, 10, 4))).toBe('2026-11-04');
  });
});
