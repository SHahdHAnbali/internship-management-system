import type { Cell, Row, Sheet } from 'write-excel-file/universal';
import type { ExportDocument, ExportSection } from './model';

/** Excel sheet names: at most 31 characters, none of `[]:*?/\`, unique in the workbook. */
function sheetName(name: string, used: Set<string>): string {
  const base =
    name
      .replace(/[[\]:*?/\\]/g, ' ')
      .trim()
      .slice(0, 31) || 'Report';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base.slice(0, 28)} ${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function sectionSheet(doc: ExportDocument, section: ExportSection, used: Set<string>): Sheet<Blob> {
  const header: Row = section.columns.map((c) => ({ value: c.label, fontWeight: 'bold' }));
  const top: Row[] = [
    [{ value: doc.title, fontWeight: 'bold', fontSize: 14 }],
    ...doc.details.map((line): Row => [line]),
    [doc.generated],
    ...(section.heading ? [[{ value: section.heading, fontWeight: 'bold' } as Cell]] : []),
    [],
  ];
  const body: Row[] =
    section.rows.length === 0
      ? [[section.empty]]
      : section.rows.map((row) =>
          row.map(
            (value, i): Cell =>
              section.columns[i]?.numeric && typeof value === 'number'
                ? { value, type: Number }
                : { value: String(value), type: String },
          ),
        );
  // Widths in characters, from the longest value in each column (bounded).
  const columns = section.columns.map((c, i) => ({
    width: Math.min(
      60,
      Math.max(10, c.label.length + 2, ...section.rows.map((r) => String(r[i] ?? '').length + 2)),
    ),
  }));
  return {
    data: [...top, header, ...body],
    sheet: sheetName(section.heading ?? doc.title, used),
    columns,
    rightToLeft: doc.direction === 'rtl',
    stickyRowsCount: top.length + 1, // the title block and the header row stay visible
  };
}

/** The report as an `.xlsx` workbook: one sheet per section, right-to-left for Arabic. */
export async function buildXlsx(doc: ExportDocument): Promise<Blob> {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const used = new Set<string>();
  return writeExcelFile(
    doc.sections.map((s) => sectionSheet(doc, s, used)),
    { fontFamily: doc.direction === 'rtl' ? 'Arial' : 'Calibri', fontSize: 11 },
  ).toBlob();
}
