import { useI18n } from '../i18n/context';

/** Company logo (public/brand/progineer-logo.png, 420×160). */
export function Logo({
  className = 'h-9 w-auto sm:h-12',
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  const { t } = useI18n();
  return (
    <img
      src="/brand/progineer-logo.png"
      width={420}
      height={160}
      className={className}
      alt={decorative ? '' : t('home.logoAlt')}
      fetchPriority={decorative ? undefined : 'high'}
      loading={decorative ? 'lazy' : undefined}
    />
  );
}
