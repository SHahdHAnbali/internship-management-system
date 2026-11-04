import { buildXlsx } from './excel';
import type { ExportDocument } from './model';
import { buildPdf, loadPdfFonts } from './pdf';

export type ExportFormat = 'xlsx' | 'pdf';

/** Gives the browser a file to save (`fileName` includes the extension). */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The exported file for `doc`, built in the browser. */
export async function exportFile(doc: ExportDocument, format: ExportFormat): Promise<Blob> {
  if (format === 'xlsx') return buildXlsx(doc);
  const bytes = await buildPdf(doc, await loadPdfFonts());
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

/** Today's date as `YYYY-MM-DD` on this device, for file names. */
export function fileDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
