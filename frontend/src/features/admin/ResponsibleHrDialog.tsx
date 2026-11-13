import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { useI18n } from '../../i18n/context';
import { adminApi } from './adminApi';
import type { AcceptedTrainee, User } from './models';

/**
 * Admin: the responsible HR of one accepted application (AD-64). Shows the HR member who accepted it, the current
 * responsible HR (and whether they still hold the HR role) and every earlier appointment; the Admin chooses a user who
 * holds the HR role now, reviews, then confirms once. Mentor-request notifications go to the current responsible HR only.
 */
export function ResponsibleHrDialog({
  trainee,
  onSaved,
  onFailed,
  onClose,
}: {
  trainee: AcceptedTrainee;
  onSaved: (updated: AcceptedTrainee) => void;
  onFailed: (error: unknown) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const { acceptedBy, current, changes } = trainee.responsibleHr;
  const name = trainee.trainee.fullName ?? '';
  const [candidates, setCandidates] = useState<User[] | null>(null);
  const [hrId, setHrId] = useState('');
  const [touched, setTouched] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const sent = useRef(false);
  const date = (value: string) => new Date(value).toLocaleDateString(language);

  useEffect(() => {
    let active = true;
    adminApi.listUsers().then(
      (users) => {
        // Only users who hold the HR role now; the current responsible HR is already appointed.
        if (active)
          setCandidates(
            users.filter((u) => u.role === 'HR' && !(current.isHr && u.id === current.id)),
          );
      },
      (error: unknown) => {
        if (active) onFailed(error);
      },
    );
    return () => {
      active = false;
    };
  }, [current.id, current.isHr, onFailed]);

  const chosen = candidates?.find((u) => u.id === hrId) ?? null;
  const error = touched && !chosen ? 'admin.acceptedTrainees.errors.chooseHr' : null;

  const review = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (chosen) setReviewing(true);
  };

  const confirm = async () => {
    if (!chosen || sent.current) return;
    sent.current = true;
    setSaving(true);
    try {
      onSaved(await adminApi.appointResponsibleHr(trainee.applicationId, chosen.id));
    } catch (failure) {
      onFailed(failure);
    }
  };

  return (
    <Dialog open title={t('admin.acceptedTrainees.changeTitle', { name })} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-small text-muted">{t('admin.acceptedTrainees.acceptedBy')}</dt>
            <dd className="font-semibold">{acceptedBy.fullName}</dd>
          </div>
          <div>
            <dt className="text-small text-muted">{t('admin.acceptedTrainees.currentHr')}</dt>
            <dd className="font-semibold">
              {current.fullName}{' '}
              {!current.isHr && (
                <span className="ims-badge">{t('admin.acceptedTrainees.notHr')}</span>
              )}
            </dd>
          </div>
        </dl>
        {!current.isHr && (
          <p className="text-small text-muted">{t('admin.acceptedTrainees.noRecipient')}</p>
        )}

        {changes.length > 0 && (
          <section aria-labelledby="responsible-hr-history">
            <h3 id="responsible-hr-history" className="mb-2 font-semibold text-heading">
              {t('admin.acceptedTrainees.history')}
            </h3>
            <ol className="flex flex-col gap-1">
              {changes.map((c) => (
                <li key={c.sequence} className="text-small">
                  {t('admin.acceptedTrainees.historyItem', {
                    hr: c.hr.fullName,
                    admin: c.changedBy,
                    date: date(c.changedAt),
                  })}
                </li>
              ))}
            </ol>
          </section>
        )}

        {!reviewing ? (
          <form className="flex flex-col gap-4" onSubmit={review} noValidate>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="responsible-hr" className="ims-label">
                {t('admin.acceptedTrainees.newHr')} *
              </label>
              <select
                id="responsible-hr"
                className="ims-input"
                value={hrId}
                disabled={candidates === null}
                aria-invalid={!!error}
                aria-describedby={error ? 'responsible-hr-error' : undefined}
                onChange={(e) => setHrId(e.target.value)}
              >
                <option value="">{t('admin.acceptedTrainees.chooseHr')}</option>
                {candidates?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
              {candidates?.length === 0 && (
                <p className="text-small text-muted">{t('admin.acceptedTrainees.noCandidates')}</p>
              )}
              {error && (
                <p id="responsible-hr-error" className="ims-error">
                  {t(error)}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="ims-btn-outline" onClick={onClose}>
                {t('admin.actions.cancel')}
              </button>
              <button type="submit" className="ims-btn-primary">
                {t('admin.acceptedTrainees.review')}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p>{t('admin.acceptedTrainees.reviewText', { hr: chosen?.fullName ?? '', name })}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="ims-btn-outline"
                disabled={saving}
                onClick={() => setReviewing(false)}
              >
                {t('admin.acceptedTrainees.back')}
              </button>
              <button
                type="button"
                className="ims-btn-primary"
                aria-disabled={saving}
                onClick={() => void confirm()}
              >
                {t('admin.acceptedTrainees.confirm')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
