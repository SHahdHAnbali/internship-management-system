import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../i18n/context';
import {
  notificationLink,
  notificationsApi,
  type AppNotification,
  type Inbox,
} from './notificationsApi';

/**
 * The in-app notifications of HR and Employee users (PDF §7, §8; owner decision C4: only these two roles): a header
 * button with the unread count that opens the list, newest first. "Load more" fetches older pages until every
 * notification, read or not, has been shown (owner decision C3). Opening a notification marks it read (PDF §8 "read or
 * not") and goes to the record it is about.
 */
export function NotificationsMenu() {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /** The first (newest) page; replaces what is shown, with the current unread count. */
  const load = useCallback(
    () =>
      notificationsApi.inbox().then(
        (result) => {
          setInbox(result);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  /** The next older page, after the last notification shown. */
  const loadMore = async () => {
    const last = inbox?.notifications.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await notificationsApi.inbox(last.id);
      setInbox((current) => {
        if (!current) return page;
        const shown = new Set(current.notifications.map((n) => n.id));
        return {
          unreadCount: page.unreadCount,
          hasMore: page.hasMore,
          notifications: [
            ...current.notifications,
            ...page.notifications.filter((n) => !shown.has(n.id)),
          ],
        };
      });
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  // Close on Escape or a click outside.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const unread = inbox?.unreadCount ?? 0;
  const notifications = inbox?.notifications ?? [];

  const message = (n: AppNotification) =>
    t(`notifications.types.${n.type}`, {
      trainee: n.traineeName ?? '—',
      field: n.fieldName ?? '—',
      employee: n.employeeName ?? '—',
    });

  const openNotification = async (n: AppNotification) => {
    setOpen(false);
    if (!n.isRead) {
      try {
        await notificationsApi.markRead(n.id);
        setInbox(
          (current) =>
            current && {
              ...current,
              unreadCount: Math.max(0, current.unreadCount - 1),
              notifications: current.notifications.map((x) =>
                x.id === n.id ? { ...x, isRead: true } : x,
              ),
            },
        );
      } catch {
        // Still open the record; the notification stays unread and can be opened again.
      }
    }
    navigate(notificationLink(n));
  };

  return (
    <div
      ref={container}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="ims-btn-text gap-2"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('notifications.button', { count: unread })}
        onClick={() => {
          if (!open) void load();
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">{t('notifications.title')}</span>
        {unread > 0 && (
          <span aria-hidden="true" className="ims-badge">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          className="ims-card absolute end-0 top-full z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] p-0"
        >
          <h2 className="border-b border-divider px-4 py-3 font-semibold text-heading">
            {t('notifications.title')}
          </h2>
          {failed && (
            <p role="alert" className="ims-error px-4 py-3">
              {t('notifications.loadFailed')}
            </p>
          )}
          {notifications.length === 0 ? (
            !failed && (
              <p className="px-4 py-3 text-small text-muted">
                {inbox ? t('notifications.empty') : ''}
              </p>
            )
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <ul>
                {notifications.map((n) => (
                  <li key={n.id} className="border-b border-divider last:border-b-0">
                    <button
                      type="button"
                      onClick={() => void openNotification(n)}
                      className={`flex w-full flex-col gap-1 px-4 py-3 text-start hover:bg-surface-subtle ${n.isRead ? 'text-muted' : 'bg-primary-soft text-heading'}`}
                    >
                      <span className={n.isRead ? '' : 'font-semibold'}>
                        {!n.isRead && (
                          <span className="sr-only">{t('notifications.unread')}: </span>
                        )}
                        {message(n)}
                      </span>
                      <span className="text-small text-muted">
                        {new Date(n.createdAt).toLocaleString(language)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {inbox?.hasMore && (
                <div className="border-t border-divider px-4 py-3">
                  <button
                    type="button"
                    className="ims-btn-outline w-full"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {t('notifications.loadMore')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
