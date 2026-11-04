/**
 * A report as it is exported (Excel or PDF): exactly the columns and rows the page shows, already formatted and
 * translated for the viewer's language. Built in the browser from the data the page loaded with the viewer's own
 * session, so an export can never contain more than the viewer may see.
 */
export interface ExportColumn {
  label: string;
  /** Relative width (default 1). */
  width?: number;
  /** Values are counts: written as numbers in Excel, centred in the PDF. */
  numeric?: boolean;
}

export interface ExportSection {
  /** Shown above the table, and the sheet name in Excel; the report title when absent. */
  heading?: string;
  columns: ExportColumn[];
  /** Cells in column order; text exactly as the page shows it, counts as numbers. */
  rows: (string | number)[][];
  /** Shown instead of rows when there are none (the page's own empty message). */
  empty: string;
}

export interface ExportDocument {
  title: string;
  /** Lines under the title: the filters in use, the period, the trainee, … */
  details: string[];
  /** "Exported on …", already translated. */
  generated: string;
  direction: 'rtl' | 'ltr';
  /** BCP 47 language of the labels (`ar`, `en`). */
  language: string;
  sections: ExportSection[];
  /** File name without extension. */
  fileName: string;
}

/** A file-name-safe version of `text` (letters of any script, digits, dashes). */
export function fileNamePart(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
