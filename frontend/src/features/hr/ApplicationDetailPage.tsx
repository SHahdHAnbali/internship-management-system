import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { openFileLink } from '../../lib/fileLinks';
import { hrApi } from './hrApi';
import type { ContactLogEntry, ContactMethod, HrApplication, HrMentor } from './models';

/**
 * HR: one application with the trainee's details and files. HR puts it under review, then accepts it or rejects it
 * with a reason (PDF §4; owner decision 2026-10-29: a decision can be made from Submitted or Under Review, and is final).
 * The application's current responsible HR may then assign its trainee directly to a mentor (AD-67).
 */
export function ApplicationDetailPage() {
  const { id = '' } = useParams();
  const { t, language } = useI18n();
  const toast = useToast();
  const [application, setApplication] = useState<HrApplication | null>(null);
  const [failed, setFailed] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => hrApi.application(id).then(setApplication, () => setFailed(true)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<HrApplication>, reload = false) => {
    setBusy(true);
    try {
      setApplication({ ...(await action()), attachments: application?.attachments });
      toast('hr.applications.saved');
      // After acceptance, the detail also says whether a direct assignment is now possible (AD-67).
      if (reload) void load();
    } catch (error) {
      toast(
        error instanceof ApiError && error.status === 409
          ? 'training.errors.conflict'
          : 'training.errors.generic',
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (failed) return <p className="ims-state">{t('training.errors.loadFailed')}</p>;
  if (!application) return null;
  const a = application;
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const open = a.status === 'Submitted' || a.status === 'UnderReview';

  const detail = (label: string, value: string | number | null) => (
    <div>
      <dt className="text-small text-muted">{t(label)}</dt>
      <dd className="text-heading">{value ?? '—'}</dd>
    </div>
  );

  return (
    <>
      <Link to="/hr/applications" className="ims-btn-text mb-4 inline-flex">
        {t('hr.applications.back')}
      </Link>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="ims-page-title">{a.trainee.fullName ?? a.trainee.email}</h1>
        <span className="ims-badge">{t(`training.applicationStatus.${a.status}`)}</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="ims-card" aria-labelledby="trainee-title">
          <h2 id="trainee-title" className="mb-4 text-h3 font-semibold text-heading">
            {t('hr.applications.trainee')}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {detail('training.profile.email', a.trainee.email)}
            {detail('training.profile.phone', a.trainee.phone)}
            {detail('training.profile.university', a.trainee.university)}
            {detail('training.profile.major', a.trainee.major)}
            {detail('training.profile.studyYear', a.trainee.studyYear)}
          </dl>
        </section>

        <section className="ims-card" aria-labelledby="request-title">
          <h2 id="request-title" className="mb-4 text-h3 font-semibold text-heading">
            {t('hr.applications.request')}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {detail('training.fields.field', a.field.name)}
            {detail('training.fields.period', `${date(a.availableFrom)} – ${date(a.availableTo)}`)}
            {detail('training.fields.hours', a.hours)}
            {detail(
              'training.fields.mandatoryForUniversity',
              t(a.mandatoryForUniversity ? 'training.yes' : 'training.no'),
            )}
            {detail('training.fields.submittedAt', date(a.submittedAt))}
            {a.rejectionReason && detail('hr.applications.rejectionReason', a.rejectionReason)}
          </dl>
          {a.attachments && a.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {a.attachments.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  className="ims-btn-outline"
                  onClick={() =>
                    openFileLink(() => hrApi.fileLink(file.id)).catch(() =>
                      toast('training.errors.fileUnavailable'),
                    )
                  }
                >
                  {t(`training.attachmentKind.${file.kind}`)}: {file.fileName}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <ContactLog applicationId={a.id} />

      {open && (
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {a.status === 'Submitted' && (
            <button
              type="button"
              className="ims-btn-outline"
              disabled={busy}
              onClick={() => void act(() => hrApi.review(a.id))}
            >
              {t('hr.applications.review')}
            </button>
          )}
          <button
            type="button"
            className="ims-btn-outline"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            {t('hr.applications.reject')}
          </button>
          <button
            type="button"
            className="ims-btn-primary"
            disabled={busy}
            onClick={() => void act(() => hrApi.accept(a.id), true)}
          >
            {t('hr.applications.accept')}
          </button>
        </div>
      )}

      {a.canDirectAssign && (
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="ims-btn-primary"
            aria-label={t('hr.directAssign.actionFor', {
              name: a.trainee.fullName ?? a.trainee.email,
            })}
            onClick={() => setAssigning(true)}
          >
            {t('hr.directAssign.action')}
          </button>
        </div>
      )}

      {assigning && (
        <DirectAssignDialog
          application={a}
          onClose={() => setAssigning(false)}
          onDone={(message) => {
            setAssigning(false);
            toast(message);
            void load();
          }}
        />
      )}

      {rejecting && (
        <RejectDialog
          onClose={() => setRejecting(false)}
          onReject={(reason) => {
            setRejecting(false);
            void act(() => hrApi.reject(a.id, reason));
          }}
        />
      )}
    </>
  );
}

type DirectAssignProblem = 'mentor' | 'mentorNotEmployee' | 'date' | 'period';

/**
 * AD-67: the application's current responsible HR assigns its trainee directly to a mentor (a user who holds the Employee
 * role now; no request or acceptance from them), with the start and planned end dates (end on or after start). Every
 * pending mentor request for the trainee is rejected in the same change. Reviewed, then confirmed once.
 */
function DirectAssignDialog({
  application: a,
  onClose,
  onDone,
}: {
  application: HrApplication;
  onClose: () => void;
  /** The toast to show; the page reloads. */
  onDone: (message: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [mentors, setMentors] = useState<HrMentor[] | null>(null);
  const [mentorsFailed, setMentorsFailed] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [problems, setProblems] = useState<DirectAssignProblem[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const has = (problem: DirectAssignProblem) => problems.includes(problem);
  const name = a.trainee.fullName ?? a.trainee.email;

  useEffect(() => {
    let active = true;
    hrApi.mentors().then(
      (all) => active && setMentors(all),
      () => active && setMentorsFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  const chosen = mentors?.find((m) => m.id === employeeId) ?? null;

  const review = (event: FormEvent) => {
    event.preventDefault();
    const found: DirectAssignProblem[] = [];
    if (!chosen) found.push('mentor');
    if (!startDate || !endDate) found.push('date');
    else if (endDate < startDate) found.push('period');
    setProblems(found);
    setFailed(false);
    if (found.length === 0) setReviewing(true);
  };

  const confirm = async () => {
    if (!chosen || submitting.current) return; // one submission at a time
    submitting.current = true;
    setBusy(true);
    try {
      await hrApi.directAssign(a.id, chosen.id, startDate, endDate);
      onDone('hr.directAssign.done');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403)
        return onDone('hr.directAssign.errors.notResponsible');
      if (error instanceof ApiError && error.status === 409)
        return onDone('hr.directAssign.errors.alreadyAssigned');
      const code = error instanceof ApiError ? error.code : undefined;
      if (code === 'direct_assignment.not_accepted')
        return onDone('hr.directAssign.errors.notAccepted');
      if (code === 'direct_assignment.mentor_not_employee') setProblems(['mentorNotEmployee']);
      else if (code === 'assignment.invalid_period') setProblems(['period']);
      else setFailed(true);
      setReviewing(false);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const mentorProblem = has('mentor') || has('mentorNotEmployee');
  const dateProblem = has('date') || has('period');

  return (
    <Dialog open title={t('hr.directAssign.title', { name })} onClose={busy ? () => {} : onClose}>
      {reviewing && chosen ? (
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('hr.directAssign.reviewIntro')}</p>
          <dl className="grid gap-x-4 gap-y-2 text-small sm:grid-cols-2">
            <dt className="text-muted">{t('hr.directAssign.trainee')}</dt>
            <dd className="text-heading">{name}</dd>
            <dt className="text-muted">{t('training.fields.field')}</dt>
            <dd className="text-heading">{a.field.name}</dd>
            <dt className="text-muted">{t('hr.directAssign.mentor')}</dt>
            <dd className="text-heading">{chosen.fullName}</dd>
            <dt className="text-muted">{t('hr.directAssign.startDate')}</dt>
            <dd className="text-heading">{date(startDate)}</dd>
            <dt className="text-muted">{t('hr.directAssign.endDate')}</dt>
            <dd className="text-heading">{date(endDate)}</dd>
          </dl>
          <p role="note" className="ims-card text-small text-heading">
            {t('hr.directAssign.pendingWarning')}
          </p>
          <p className="text-small text-muted">{t('hr.directAssign.note')}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="ims-btn-text"
              disabled={busy}
              onClick={() => setReviewing(false)}
            >
              {t('hr.trainings.back')}
            </button>
            <button
              type="button"
              className="ims-btn-primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {t('hr.directAssign.confirm')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={review} noValidate className="flex flex-col gap-4">
          <dl className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-2">
            <dt className="text-muted">{t('hr.directAssign.trainee')}</dt>
            <dd className="text-heading">{name}</dd>
            <dt className="text-muted">{t('training.fields.field')}</dt>
            <dd className="text-heading">{a.field.name}</dd>
          </dl>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-mentor`}>
              {t('hr.directAssign.mentor')}
            </label>
            <select
              id={`${id}-mentor`}
              className="ims-input"
              value={employeeId}
              disabled={mentors === null}
              aria-invalid={mentorProblem || undefined}
              aria-describedby={mentorProblem ? `${id}-mentor-error` : undefined}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">{t('hr.trainings.chooseMentor')}</option>
              {mentors?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                </option>
              ))}
            </select>
            {mentors?.length === 0 && (
              <p className="text-small text-muted">{t('hr.directAssign.noMentors')}</p>
            )}
            {mentorsFailed && (
              <p role="alert" className="ims-error">
                {t('training.errors.generic')}
              </p>
            )}
            {mentorProblem && (
              <p id={`${id}-mentor-error`} role="alert" className="ims-error">
                {t(
                  has('mentorNotEmployee')
                    ? 'hr.directAssign.errors.mentorNotEmployee'
                    : 'hr.directAssign.errors.mentor',
                )}
              </p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="ims-label" htmlFor={`${id}-start`}>
                {t('hr.directAssign.startDate')}
              </label>
              <input
                id={`${id}-start`}
                type="date"
                className="ims-input"
                value={startDate}
                aria-invalid={dateProblem || undefined}
                aria-describedby={dateProblem ? `${id}-date-error` : undefined}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="ims-label" htmlFor={`${id}-end`}>
                {t('hr.directAssign.endDate')}
              </label>
              <input
                id={`${id}-end`}
                type="date"
                className="ims-input"
                min={startDate || undefined}
                value={endDate}
                aria-invalid={dateProblem || undefined}
                aria-describedby={dateProblem ? `${id}-date-error` : undefined}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          {dateProblem && (
            <p id={`${id}-date-error`} role="alert" className="ims-error">
              {t(has('period') ? 'hr.directAssign.errors.period' : 'hr.directAssign.errors.dates')}
            </p>
          )}
          {failed && (
            <p role="alert" className="ims-error">
              {t('training.errors.generic')}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="ims-btn-text" onClick={onClose}>
              {t('training.cancel')}
            </button>
            <button type="submit" className="ims-btn-primary">
              {t('hr.trainings.review')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

const METHODS: ContactMethod[] = ['Phone', 'Meeting', 'Email'];

/**
 * The contact log (PDF §4, §8): each call or verbal agreement with its date, method and summary. HR records it while
 * reviewing; no decision depends on it.
 */
function ContactLog({ applicationId }: { applicationId: string }) {
  const { t, language } = useI18n();
  const toast = useToast();
  const id = useId();
  const [entries, setEntries] = useState<ContactLogEntry[] | null>(null);
  const [contactDate, setContactDate] = useState('');
  const [method, setMethod] = useState<ContactMethod | ''>('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () => hrApi.contactLogs(applicationId).then(setEntries, () => setEntries([])),
    [applicationId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!contactDate || !method || summary.trim() === '') {
      setError(true);
      return;
    }

    setSaving(true);
    try {
      await hrApi.addContactLog(applicationId, { contactDate, method, summary: summary.trim() });
      setContactDate('');
      setMethod('');
      setSummary('');
      setError(false);
      toast('hr.contactLog.saved');
      await load();
    } catch {
      toast('training.errors.generic');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="ims-card mt-6" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mb-4 text-h3 font-semibold text-heading">
        {t('hr.contactLog.title')}
      </h2>
      <form onSubmit={(e) => void add(e)} className="mb-6 grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-date`}>
            {t('hr.contactLog.date')}
          </label>
          <input
            id={`${id}-date`}
            type="date"
            className="ims-input"
            value={contactDate}
            aria-invalid={(error && !contactDate) || undefined}
            onChange={(e) => setContactDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-method`}>
            {t('hr.contactLog.method')}
          </label>
          <select
            id={`${id}-method`}
            className="ims-input"
            value={method}
            aria-invalid={(error && !method) || undefined}
            onChange={(e) => setMethod(e.target.value as ContactMethod | '')}
          >
            <option value="" disabled>
              {t('hr.contactLog.chooseMethod')}
            </option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`hr.contactLog.methods.${m}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label className="ims-label" htmlFor={`${id}-summary`}>
            {t('hr.contactLog.summary')}
          </label>
          <textarea
            id={`${id}-summary`}
            className="ims-input min-h-20"
            value={summary}
            maxLength={4000}
            aria-invalid={(error && summary.trim() === '') || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="ims-error sm:col-span-2">
            {t('hr.contactLog.required')}
          </p>
        )}
        <div className="flex justify-end sm:col-span-2">
          <button type="submit" className="ims-btn-outline" disabled={saving}>
            {t('hr.contactLog.add')}
          </button>
        </div>
      </form>
      {entries && entries.length === 0 ? (
        <p className="text-small text-muted">{t('hr.contactLog.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries?.map((entry) => (
            <li key={entry.id} className="rounded-control bg-surface-subtle p-3">
              <p className="text-small text-muted">
                {new Date(entry.contactDate).toLocaleDateString(language)} ·{' '}
                {t(`hr.contactLog.methods.${entry.method}`)} · {entry.authorName}
              </p>
              <p className="mt-1 whitespace-pre-line">{entry.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RejectDialog({
  onClose,
  onReject,
}: {
  onClose: () => void;
  onReject: (reason: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() === '') setError(true);
    else onReject(reason.trim());
  };

  return (
    <Dialog open title={t('hr.applications.rejectTitle')} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-reason`}>
            {t('hr.applications.rejectionReason')}
          </label>
          <textarea
            id={`${id}-reason`}
            className="ims-input min-h-24"
            value={reason}
            maxLength={2000}
            aria-invalid={error || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="ims-error">
              {t('hr.applications.reasonRequired')}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="ims-btn-text" onClick={onClose}>
            {t('training.cancel')}
          </button>
          <button type="submit" className="ims-btn-primary">
            {t('hr.applications.reject')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
