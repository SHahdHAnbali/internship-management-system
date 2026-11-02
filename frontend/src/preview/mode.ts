const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Admin Preview Mode (`npm run start:preview`) is compiled only into the `admin-preview` Vite mode, and is active only
 * on a dev server on this machine. In every other build `import.meta.env.MODE` is a different constant, so this is
 * `false` and the preview code is removed from the bundle. See docs/admin-preview.md.
 */
export const previewActive: boolean =
  import.meta.env.MODE === 'admin-preview' &&
  import.meta.env.DEV &&
  typeof location !== 'undefined' &&
  LOCAL_HOSTS.has(location.hostname);
