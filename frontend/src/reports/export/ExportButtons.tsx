import { useState } from 'react';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { exportFile, saveFile, type ExportFormat } from './files';
import type { ExportDocument } from './model';

/**
 * "Excel" and "PDF" buttons for a report (PDF §6 «ويُصدَّر Excel أو PDF»). `build` returns exactly what the page shows
 * now (columns, rows, filters), from the data it loaded with the viewer's own session; nothing else is fetched.
 * Disabled while the report has nothing to show (loading or failed).
 */
export function ExportButtons({
  build,
  disabled,
}: {
  build: () => ExportDocument | null;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    const doc = build();
    if (!doc) return;
    setBusy(format);
    try {
      saveFile(await exportFile(doc, format), `${doc.fileName}.${format}`);
    } catch {
      toast('reports.export.failed');
    } finally {
      setBusy(null);
    }
  };

  const off = disabled || busy !== null;
  return (
    <div role="group" aria-label={t('reports.export.label')} className="flex flex-wrap gap-2">
      {(['xlsx', 'pdf'] as const).map((format) => (
        <button
          key={format}
          type="button"
          className="ims-btn-outline"
          aria-disabled={off}
          aria-busy={busy === format}
          onClick={() => {
            if (!off) void run(format);
          }}
        >
          {t(busy === format ? 'reports.export.working' : `reports.export.${format}`)}
        </button>
      ))}
    </div>
  );
}
