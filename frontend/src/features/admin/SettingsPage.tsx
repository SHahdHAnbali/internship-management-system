import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/context';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { adminCache } from './adminCache';
import { useAdminFeedback } from './feedback';
import type { NotificationSettings } from './models';
import { isValidDays } from './settingsValidation';

const SETTINGS = [
  {
    key: 'trainingEndingNoticeDays',
    label: 'admin.settings.trainingEndingNoticeDays',
    hint: 'admin.settings.trainingEndingNoticeHint',
  },
  {
    key: 'lateEvaluationReminderDays',
    label: 'admin.settings.lateEvaluationReminderDays',
    hint: 'admin.settings.lateEvaluationReminderHint',
  },
  {
    key: 'pendingRequestAlertDays',
    label: 'admin.settings.pendingRequestAlertDays',
    hint: 'admin.settings.pendingRequestAlertHint',
  },
] as const;

type Key = (typeof SETTINGS)[number]['key'];

/** Admin: the notification intervals (PDF §7: 7 days, 3 days, 5 days are settings the Admin changes). */
export function SettingsPage() {
  const { t } = useI18n();
  const feedback = useAdminFeedback();
  const cacheKey = adminCache.key(useAuth().user?.id, 'notification-settings');
  // Values loaded earlier in this session show at once; the fresh ones replace them unless the Admin started editing.
  const [values, setValues] = useState<Record<Key, string> | null>(() => {
    const cached = adminCache.get<NotificationSettings>(cacheKey);
    return cached ? toStrings(cached) : null;
  });
  const edited = useRef(false);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    adminApi
      .getNotificationSettings()
      .then((settings) => {
        adminCache.set(cacheKey, settings);
        if (!edited.current) setValues(toStrings(settings));
      })
      .catch((error: unknown) => feedback.error(error));
  }, [feedback, cacheKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!values || SETTINGS.some((s) => !isValidDays(values[s.key]))) return;

    setSaving(true);
    try {
      const saved = await adminApi.updateNotificationSettings({
        trainingEndingNoticeDays: Number(values.trainingEndingNoticeDays),
        lateEvaluationReminderDays: Number(values.lateEvaluationReminderDays),
        pendingRequestAlertDays: Number(values.pendingRequestAlertDays),
      });
      adminCache.set(cacheKey, saved);
      edited.current = false;
      setValues(toStrings(saved));
      feedback.saved();
    } catch (error) {
      feedback.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={t('admin.settings.title')} />

      <form
        className="ims-card flex max-w-[520px] flex-col gap-4"
        onSubmit={(e) => void submit(e)}
        noValidate
      >
        {SETTINGS.map((setting) => {
          const value = values?.[setting.key] ?? '';
          const invalid = touched && !!values && !isValidDays(value);
          return (
            <div key={setting.key} className="flex flex-col gap-1 border-b border-divider pb-4">
              <label htmlFor={setting.key} className="font-semibold text-heading">
                {t(setting.label)}
              </label>
              <p className="text-muted">{t(setting.hint)}</p>
              <div className="relative mt-2 w-40">
                <input
                  id={setting.key}
                  className="ims-input pe-14"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  required
                  disabled={!values}
                  value={value}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? `${setting.key}-error` : undefined}
                  onChange={(e) => {
                    edited.current = true;
                    setValues((v) => (v ? { ...v, [setting.key]: e.target.value } : v));
                  }}
                />
                <span className="pointer-events-none absolute inset-y-0 end-3.5 flex items-center text-muted">
                  {t('admin.settings.days')}
                </span>
              </div>
              {invalid && (
                <p id={`${setting.key}-error`} className="ims-error">
                  {t('admin.validation.days')}
                </p>
              )}
            </div>
          );
        })}

        <div className="flex justify-end gap-2">
          <button type="submit" className="ims-btn-primary" disabled={saving || !values}>
            {t('admin.actions.save')}
          </button>
        </div>
      </form>
    </>
  );
}

function toStrings(settings: NotificationSettings): Record<Key, string> {
  return {
    trainingEndingNoticeDays: String(settings.trainingEndingNoticeDays),
    lateEvaluationReminderDays: String(settings.lateEvaluationReminderDays),
    pendingRequestAlertDays: String(settings.pendingRequestAlertDays),
  };
}
