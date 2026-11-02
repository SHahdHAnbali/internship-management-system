import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './styles/main.scss';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './i18n/I18nProvider';

async function bootstrap() {
  // Admin Preview Mode exists only in the `admin-preview` Vite mode; in every other build this branch is removed.
  if (import.meta.env.MODE === 'admin-preview') {
    const { installAdminPreview } = await import('./features/admin/preview/installAdminPreview');
    installAdminPreview();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

void bootstrap();
