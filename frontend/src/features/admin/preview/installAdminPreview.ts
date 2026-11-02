import { setApiMock } from '../../../lib/api';
import { previewActive } from '../../../preview/mode';
import { AdminPreviewStore } from './adminPreviewStore';

/**
 * Admin Preview Mode only (`npm run start:preview`, imported from main.tsx behind the `admin-preview` Vite mode).
 * Admin API calls are answered by an in-memory mock; every other request — and the real backend — is untouched.
 */
export function installAdminPreview(): void {
  if (!previewActive) return;
  const store = new AdminPreviewStore();
  setApiMock((method, url, body) => store.handle(method, url, body));
  console.warn(
    '[IMS] Admin Preview Mode: /api/admin is served by in-browser mock data. Nothing is saved.',
  );
}
