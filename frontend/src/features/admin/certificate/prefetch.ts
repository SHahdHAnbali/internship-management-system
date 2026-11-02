import { adminApi } from '../adminApi';
import { adminCache } from '../adminCache';

/**
 * Loads the saved certificate template into the Admin cache in the background when the Admin area opens, so the
 * editor shows it at once on its first visit (the editor still refreshes it when opened). Never replaces a template
 * already loaded; errors are left to the editor, which reports them when it loads.
 */
export function prefetchCertificateTemplate(userId: string | undefined): void {
  const key = adminCache.key(userId, 'certificate-template');
  if (adminCache.get(key) !== undefined) return;
  adminApi.getCertificateTemplate().then(
    (template) => {
      if (adminCache.get(key) === undefined) adminCache.set(key, template);
    },
    () => undefined,
  );
}
