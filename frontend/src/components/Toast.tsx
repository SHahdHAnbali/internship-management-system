import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type ShowToast } from './toastContext';
import { useI18n } from '../i18n/context';

/** Short dark message at the bottom of the screen (4 s), announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback<ShowToast>((messageKey) => {
    clearTimeout(timer.current);
    setMessage(messageKey);
    timer.current = setTimeout(() => setMessage(null), 4000);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-gutter"
      >
        {message && (
          <div
            role="status"
            className="pointer-events-auto flex min-h-12 max-w-md items-center gap-4 rounded-control bg-heading px-4 py-2 text-sm text-white shadow-raised"
          >
            <span>{t(message)}</span>
            <button
              type="button"
              className="font-semibold text-primary-soft hover:text-white"
              onClick={() => setMessage(null)}
            >
              {t('admin.actions.close')}
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
