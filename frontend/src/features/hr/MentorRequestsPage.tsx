import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { hrApi } from './hrApi';
import type { HrMentorRequest } from './models';

/**
 * HR: every employee's requests to train a trainee (PDF §4). Approving after coordination sets the start and end dates
 * and starts the training; rejecting returns the trainee to the available list.
 */
export function MentorRequestsPage() {
  const { t, language } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<HrMentorRequest['status'] | ''>('Pending');
  const [requests, setRequests] = useState<HrMentorRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [approving, setApproving] = useState<HrMentorRequest | null>(null);
  const id = useId();

  const load = useCallback(
    () =>
      hrApi.mentorRequests(status).then(
        (list) => {
          setRequests(list);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [status],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      toast('hr.mentorRequests.saved');
    } catch (error) {
      toast(
        error instanceof ApiError && error.status === 409
          ? 'training.errors.conflict'
          : 'training.errors.generic',
      );
    }

    await load();
  };

  const date = (value: string) => new Date(value).toLocaleDateString(language);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="ims-page-title">{t('hr.mentorRequests.title')}</h1>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-status`}>
            {t('hr.applications.status')}
          </label>
          <select
            id={`${id}-status`}
            className="ims-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as HrMentorRequest['status'] | '')}
          >
            <option value="">{t('hr.applications.all')}</option>
            {(['Pending', 'Approved', 'Rejected'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`training.requestStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {failed ? (
        <p className="ims-state">{t('training.errors.loadFailed')}</p>
      ) : requests?.length === 0 ? (
        <p className="ims-state">{t('hr.mentorRequests.empty')}</p>
      ) : (
        requests && (
          <ul className="flex flex-col gap-4">
            {requests.map((r) => (
              <li key={r.id} className="ims-card flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="font-semibold text-heading">
                      {t('hr.mentorRequests.summary', {
                        employee: r.employee.fullName,
                        trainee: r.application.traineeName ?? '',
                      })}
                    </h2>
                    <p className="text-small text-muted">
                      {r.application.fieldName} · {date(r.application.availableFrom)} –{' '}
                      {date(r.application.availableTo)}
                      {' · '}
                      {date(r.requestedAt)}
                    </p>
                  </div>
                  <span className="ims-badge">{t(`training.requestStatus.${r.status}`)}</span>
                </div>
                <p className="whitespace-pre-line">{r.note}</p>
                {r.status === 'Pending' && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="ims-btn-outline"
                      onClick={() => void act(() => hrApi.rejectRequest(r.id))}
                    >
                      {t('hr.mentorRequests.reject')}
                    </button>
                    <button
                      type="button"
                      className="ims-btn-primary"
                      onClick={() => setApproving(r)}
                    >
                      {t('hr.mentorRequests.approve')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {approving && (
        <ApproveDialog
          request={approving}
          onClose={() => setApproving(null)}
          onApprove={(start, end) => {
            const target = approving;
            setApproving(null);
            void act(() => hrApi.approve(target.id, start, end));
          }}
        />
      )}
    </>
  );
}

function ApproveDialog({
  request,
  onClose,
  onApprove,
}: {
  request: HrMentorRequest;
  onClose: () => void;
  onApprove: (startDate: string, endDate: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [start, setStart] = useState(request.application.availableFrom);
  const [end, setEnd] = useState(request.application.availableTo);
  const invalid = !start || !end || end < start;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!invalid) onApprove(start, end);
  };

  return (
    <Dialog open title={t('hr.mentorRequests.approveTitle')} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-muted">{t('hr.mentorRequests.approveExplain')}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-start`}>
              {t('hr.mentorRequests.startDate')}
            </label>
            <input
              id={`${id}-start`}
              type="date"
              className="ims-input"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-end`}>
              {t('hr.mentorRequests.endDate')}
            </label>
            <input
              id={`${id}-end`}
              type="date"
              className="ims-input"
              required
              value={end}
              aria-invalid={(Boolean(start) && Boolean(end) && end < start) || undefined}
              aria-describedby={end && start && end < start ? `${id}-error` : undefined}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        {start && end && end < start && (
          <p id={`${id}-error`} role="alert" className="ims-error">
            {t('hr.mentorRequests.invalidPeriod')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="ims-btn-text" onClick={onClose}>
            {t('training.cancel')}
          </button>
          <button type="submit" className="ims-btn-primary" aria-disabled={invalid || undefined}>
            {t('hr.mentorRequests.approve')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
