import { useI18n } from '../i18n/context';
import { previewActive } from '../preview/mode';

/** Shown on every page while Admin Preview Mode is active, so mock data is never mistaken for real data. */
export function PreviewBanner() {
  const { t } = useI18n();
  if (!previewActive) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-brand/30 bg-primary-soft px-gutter py-2 text-center text-small text-primary"
    >
      <span className="font-semibold">{t('preview.title')}</span>
      <span>{t('preview.description')}</span>
    </div>
  );
}
