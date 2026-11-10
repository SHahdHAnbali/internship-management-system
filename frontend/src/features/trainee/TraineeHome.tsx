import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { openFileLink } from '../../lib/fileLinks';
import type { MyApplication } from './models';
import { traineeApi } from './traineeApi';

/**
 * The status board (PDF §4): where each of the trainee's own applications stands; no other trainee is visible. A rejected
 * application shows the reason HR recorded (AD-61).
 */
export function TraineeHome() {
  const { t, language } = useI18n();
  const toast = useToast();
  const [applications, setApplications] = useState<MyApplication[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    traineeApi.applications().then(setApplications, () => setFailed(true));
  }, []);

  const date = (value: string) => new Date(value).toLocaleDateString(language);

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <h1 className="ims-page-title">{t('trainee.applications.title')}</h1>
        <Link to="/trainee/apply" className="ims-btn-primary">
          {t('trainee.applications.apply')}
        </Link>
      </div>

      {failed ? (
        <p className="ims-state">{t('training.errors.loadFailed')}</p>
      ) : applications?.length === 0 ? (
        <p className="ims-state">{t('trainee.applications.empty')}</p>
      ) : (
        applications && (
          <ul className="flex flex-col gap-4">
            {applications.map((a) => (
              <li key={a.id} className="ims-card flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-h3 font-semibold text-heading">{a.field.name}</h2>
                  <span className="ims-badge">{t(`training.applicationStatus.${a.status}`)}</span>
                </div>
                <dl className="grid gap-x-6 gap-y-2 text-small sm:grid-cols-3">
                  <div>
                    <dt className="text-muted">{t('training.fields.period')}</dt>
                    <dd>
                      {date(a.availableFrom)} – {date(a.availableTo)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('training.fields.hours')}</dt>
                    <dd>{a.hours}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t('training.fields.submittedAt')}</dt>
                    <dd>{date(a.submittedAt)}</dd>
                  </div>
                </dl>
                {a.status === 'Rejected' && a.rejectionReason && (
                  <dl className="rounded-control border border-border bg-surface-subtle p-3 text-small">
                    <dt className="text-muted">{t('trainee.applications.rejectionReason')}</dt>
                    {/* Plain text from HR, rendered as text (never as HTML); line breaks kept; direction from the text itself. */}
                    <dd dir="auto" className="mt-1 whitespace-pre-line break-words text-heading">
                      {a.rejectionReason}
                    </dd>
                  </dl>
                )}
                {a.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {a.attachments.map((file) => (
                      <button
                        key={file.id}
                        type="button"
                        className="ims-btn-text"
                        onClick={() =>
                          openFileLink(() => traineeApi.fileLink(file.id)).catch(() =>
                            toast('training.errors.fileUnavailable'),
                          )
                        }
                      >
                        {t(`training.attachmentKind.${file.kind}`)}: {file.fileName}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      )}
    </>
  );
}
