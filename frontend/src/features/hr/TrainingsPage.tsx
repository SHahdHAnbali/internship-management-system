import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { hrApi } from './hrApi';
import type { AssignmentStatus, HrAssignment, HrAssignmentExtension } from './models';

/**
 * HR: the trainings (assignments) as recorded (PDF §4 "running training"). Current = Active (AD-49); every other status
 * is listed as previous, with the reason HR recorded. HR ends a current training (AD-63 Phase 1): a successful
 * completion (Completed on or after the planned end date, Ended early before it, with a reason) or the trainee's
 * withdrawal (with a reason), on an actual end date between the start and today (Asia/Hebron). HR also extends a
 * current training (AD-63 L2, NEW-35): a later planned end date with a reason, any number of times; every extension is
 * kept and listed in its history (HR only). Transferring and reopening are not built.
 */
export function TrainingsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [assignments, setAssignments] = useState<HrAssignment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ending, setEnding] = useState<HrAssignment | null>(null);
  const [extending, setExtending] = useState<HrAssignment | null>(null);
  const [showingHistory, setShowingHistory] = useState<HrAssignment | null>(null);

  const load = useCallback(
    () => hrApi.assignments().then(setAssignments, () => setFailed(true)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <p className="ims-state">{t('training.errors.loadFailed')}</p>;
  if (!assignments) return null;

  const current = assignments.filter((a) => a.status === 'Active');
  const previous = assignments.filter((a) => a.status !== 'Active');

  return (
    <>
      <h1 className="ims-page-title mb-8">{t('hr.trainings.title')}</h1>
      <TrainingTable
        id="current-trainings"
        title={t('hr.trainings.current')}
        empty={t('hr.trainings.noCurrent')}
        rows={current}
        onEnd={setEnding}
        onExtend={setExtending}
        onHistory={setShowingHistory}
      />
      <TrainingTable
        id="previous-trainings"
        title={t('hr.trainings.previous')}
        empty={t('hr.trainings.noPrevious')}
        rows={previous}
        showReason
        onHistory={setShowingHistory}
      />
      {ending && (
        <EndTrainingDialog
          assignment={ending}
          onClose={() => setEnding(null)}
          onEnded={() => {
            setEnding(null);
            toast('hr.trainings.ended');
            void load();
          }}
          onConflict={() => {
            setEnding(null);
            toast('training.errors.conflict');
            void load();
          }}
        />
      )}
      {extending && (
        <ExtendTrainingDialog
          assignment={extending}
          onClose={() => setExtending(null)}
          onExtended={() => {
            setExtending(null);
            toast('hr.trainings.extended');
            void load();
          }}
          onConflict={() => {
            setExtending(null);
            toast('training.errors.conflict');
            void load();
          }}
        />
      )}
      {showingHistory && (
        <ExtensionHistoryDialog
          assignment={showingHistory}
          onClose={() => setShowingHistory(null)}
        />
      )}
    </>
  );
}

function TrainingTable({
  id,
  title,
  empty,
  rows,
  onEnd,
  onExtend,
  onHistory,
  showReason = false,
}: {
  id: string;
  title: string;
  empty: string;
  rows: HrAssignment[];
  onEnd?: (assignment: HrAssignment) => void;
  onExtend?: (assignment: HrAssignment) => void;
  onHistory?: (assignment: HrAssignment) => void;
  showReason?: boolean;
}) {
  const { t, language } = useI18n();
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const hasHistory = (a: HrAssignment) => (a.extensions?.length ?? 0) > 0;
  const showActions = Boolean(onEnd || onExtend || (onHistory && rows.some(hasHistory)));
  return (
    <section aria-labelledby={id} className="mb-10">
      <h2 id={id} className="mb-4 text-h3 font-semibold text-heading">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="ims-state">{empty}</p>
      ) : (
        <div className="ims-table-card">
          <table className="ims-table">
            <thead>
              <tr>
                <th scope="col">{t('hr.trainings.trainee')}</th>
                <th scope="col">{t('hr.trainings.mentor')}</th>
                <th scope="col">{t('training.fields.field')}</th>
                <th scope="col">{t('hr.mentorRequests.startDate')}</th>
                <th scope="col">{t('hr.mentorRequests.endDate')}</th>
                <th scope="col">{t('hr.trainings.status')}</th>
                {showReason && <th scope="col">{t('hr.trainings.reason')}</th>}
                {showActions && <th scope="col">{t('hr.trainings.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link
                      to={`/hr/reports/trainee-history?trainee=${a.trainee.id}`}
                      className="font-semibold"
                    >
                      {traineeName(a)}
                    </Link>
                  </td>
                  <td>{a.employee.fullName}</td>
                  <td>{a.fieldName}</td>
                  <td>{date(a.startDate)}</td>
                  <td>{date(a.endDate)}</td>
                  <td>
                    <span className="ims-badge">{t(`training.assignmentStatus.${a.status}`)}</span>
                  </td>
                  {showReason && (
                    <td dir="auto" className="whitespace-pre-line break-words">
                      {a.endReason ?? '—'}
                    </td>
                  )}
                  {showActions && (
                    <td>
                      <div className="flex flex-wrap gap-2">
                        {onExtend && (
                          <button
                            type="button"
                            className="ims-btn-outline"
                            aria-label={t('hr.trainings.extendFor', { name: traineeName(a) })}
                            onClick={() => onExtend(a)}
                          >
                            {t('hr.trainings.extend')}
                          </button>
                        )}
                        {onEnd && (
                          <button
                            type="button"
                            className="ims-btn-outline"
                            aria-label={t('hr.trainings.endFor', { name: traineeName(a) })}
                            onClick={() => onEnd(a)}
                          >
                            {t('hr.trainings.end')}
                          </button>
                        )}
                        {onHistory && hasHistory(a) && (
                          <button
                            type="button"
                            className="ims-btn-text"
                            aria-label={t('hr.trainings.historyFor', { name: traineeName(a) })}
                            onClick={() => onHistory(a)}
                          >
                            {t('hr.trainings.history', { count: a.extensions?.length ?? 0 })}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const traineeName = (a: HrAssignment) => a.trainee.fullName ?? a.trainee.email;

/** Today's calendar date in Asia/Hebron, the official IMS day (AD-62, AD-63), as `YYYY-MM-DD`. */
function hebronToday(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hebron',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

type Kind = 'completion' | 'withdrawal';
type Problem = 'kind' | 'date' | 'dateBeforeStart' | 'dateInFuture' | 'reason';

/** The status the server will record (AD-63, D2): the date decides Completed or Ended early. */
function outcome(kind: Kind, endDate: string, plannedEndDate: string): AssignmentStatus {
  if (kind === 'withdrawal') return 'Withdrawn';
  return endDate >= plannedEndDate ? 'Completed' : 'EndedEarly';
}

const SERVER_PROBLEMS: Record<string, Problem> = {
  'assignment.end_before_start': 'dateBeforeStart',
  'assignment.end_in_future': 'dateInFuture',
};

function EndTrainingDialog({
  assignment: a,
  onClose,
  onEnded,
  onConflict,
}: {
  assignment: HrAssignment;
  onClose: () => void;
  onEnded: () => void;
  onConflict: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const today = hebronToday();
  const [kind, setKind] = useState<Kind | null>(null);
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);

  const status = kind && endDate ? outcome(kind, endDate, a.endDate) : null;
  const needsReason = status === 'EndedEarly' || status === 'Withdrawn';
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const has = (problem: Problem) => problems.includes(problem);
  const describedBy = (...ids: string[]) => ids.filter(Boolean).join(' ') || undefined;

  const review = (event: FormEvent) => {
    event.preventDefault();
    const found: Problem[] = [];
    if (!kind) found.push('kind');
    if (!endDate) found.push('date');
    else if (endDate < a.startDate) found.push('dateBeforeStart');
    else if (endDate > today) found.push('dateInFuture');
    if (needsReason && reason.trim() === '') found.push('reason');
    setProblems(found);
    setFailed(false);
    if (found.length === 0) setReviewing(true);
  };

  const confirm = async () => {
    if (submitting.current || !kind || !status) return; // one submission at a time
    submitting.current = true;
    setBusy(true);
    try {
      if (kind === 'withdrawal') await hrApi.withdrawAssignment(a.id, endDate, reason.trim());
      else await hrApi.completeAssignment(a.id, endDate, needsReason ? reason.trim() : null);
      onEnded();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return onConflict();
      const problem = error instanceof ApiError ? SERVER_PROBLEMS[error.code ?? ''] : undefined;
      if (problem) setProblems([problem]);
      else setFailed(true);
      setReviewing(false);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t('hr.trainings.endTitle', { name: traineeName(a) })}
      onClose={busy ? () => {} : onClose}
    >
      {reviewing && status ? (
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('hr.trainings.reviewIntro')}</p>
          <dl className="grid gap-x-4 gap-y-2 text-small sm:grid-cols-2">
            <dt className="text-muted">{t('hr.trainings.trainee')}</dt>
            <dd className="text-heading">{traineeName(a)}</dd>
            <dt className="text-muted">{t('hr.trainings.recordedAs')}</dt>
            <dd className="text-heading">{t(`training.assignmentStatus.${status}`)}</dd>
            <dt className="text-muted">{t('hr.trainings.actualEndDate')}</dt>
            <dd className="text-heading">{date(endDate)}</dd>
            <dt className="text-muted">{t('hr.trainings.plannedEndDate')}</dt>
            <dd className="text-heading">{date(a.endDate)}</dd>
            {needsReason && (
              <>
                <dt className="text-muted">{t('hr.trainings.reason')}</dt>
                <dd dir="auto" className="whitespace-pre-line break-words text-heading">
                  {reason.trim()}
                </dd>
              </>
            )}
          </dl>
          <p className="text-small text-muted">{t('hr.trainings.endNote')}</p>
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
              {t('hr.trainings.confirm')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={review} noValidate className="flex flex-col gap-4">
          <fieldset
            className="flex flex-col gap-2"
            aria-invalid={has('kind') || undefined}
            aria-describedby={has('kind') ? `${id}-kind-error` : undefined}
          >
            <legend className="ims-label mb-1">{t('hr.trainings.endKind')}</legend>
            {(['completion', 'withdrawal'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-kind`}
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                {t(`hr.trainings.kind.${value}`)}
              </label>
            ))}
            {has('kind') && (
              <p id={`${id}-kind-error`} role="alert" className="ims-error">
                {t('hr.trainings.errors.kind')}
              </p>
            )}
          </fieldset>

          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-date`}>
              {t('hr.trainings.actualEndDate')}
            </label>
            <input
              id={`${id}-date`}
              type="date"
              className="ims-input"
              min={a.startDate}
              max={today}
              value={endDate}
              aria-invalid={
                has('date') || has('dateBeforeStart') || has('dateInFuture') || undefined
              }
              aria-describedby={describedBy(
                `${id}-date-hint`,
                has('date') || has('dateBeforeStart') || has('dateInFuture')
                  ? `${id}-date-error`
                  : '',
              )}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <p id={`${id}-date-hint`} className="text-small text-muted">
              {t('hr.trainings.dateHint', { start: date(a.startDate), planned: date(a.endDate) })}
            </p>
            {(has('date') || has('dateBeforeStart') || has('dateInFuture')) && (
              <p id={`${id}-date-error`} role="alert" className="ims-error">
                {t(
                  has('date')
                    ? 'hr.trainings.errors.date'
                    : has('dateBeforeStart')
                      ? 'hr.trainings.errors.dateBeforeStart'
                      : 'hr.trainings.errors.dateInFuture',
                )}
              </p>
            )}
          </div>

          {status && (
            <p className="text-small text-heading" role="status">
              {t('hr.trainings.willBe', { status: t(`training.assignmentStatus.${status}`) })}
            </p>
          )}

          {needsReason && (
            <div className="flex flex-col gap-1">
              <label className="ims-label" htmlFor={`${id}-reason`}>
                {t('hr.trainings.reason')}
              </label>
              <textarea
                id={`${id}-reason`}
                className="ims-input min-h-24"
                dir="auto"
                value={reason}
                maxLength={2000}
                aria-invalid={has('reason') || undefined}
                aria-describedby={has('reason') ? `${id}-reason-error` : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              {has('reason') && (
                <p id={`${id}-reason-error`} role="alert" className="ims-error">
                  {t('hr.trainings.errors.reason')}
                </p>
              )}
            </div>
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

/** The calendar date `days` after a `YYYY-MM-DD` date. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type ExtensionProblem = 'date' | 'notLater' | 'reason';

/**
 * AD-63 L2, NEW-35: a later planned end date (strictly after the current one, even if that has passed) and a mandatory
 * reason; reviewed, then confirmed once.
 */
function ExtendTrainingDialog({
  assignment: a,
  onClose,
  onExtended,
  onConflict,
}: {
  assignment: HrAssignment;
  onClose: () => void;
  onExtended: () => void;
  onConflict: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const earliest = addDays(a.endDate, 1);
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<ExtensionProblem[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const has = (problem: ExtensionProblem) => problems.includes(problem);
  const dateProblem = has('date') || has('notLater');

  const review = (event: FormEvent) => {
    event.preventDefault();
    const found: ExtensionProblem[] = [];
    if (!endDate) found.push('date');
    else if (endDate <= a.endDate) found.push('notLater');
    if (reason.trim() === '') found.push('reason');
    setProblems(found);
    setFailed(false);
    if (found.length === 0) setReviewing(true);
  };

  const confirm = async () => {
    if (submitting.current) return; // one submission at a time
    submitting.current = true;
    setBusy(true);
    try {
      await hrApi.extendAssignment(a.id, endDate, reason.trim());
      onExtended();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return onConflict();
      if (error instanceof ApiError && error.code === 'assignment.extension_not_later')
        setProblems(['notLater']);
      else setFailed(true);
      setReviewing(false);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t('hr.trainings.extendTitle', { name: traineeName(a) })}
      onClose={busy ? () => {} : onClose}
    >
      {reviewing ? (
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('hr.trainings.reviewIntro')}</p>
          <dl className="grid gap-x-4 gap-y-2 text-small sm:grid-cols-2">
            <dt className="text-muted">{t('hr.trainings.trainee')}</dt>
            <dd className="text-heading">{traineeName(a)}</dd>
            <dt className="text-muted">{t('hr.trainings.currentEndDate')}</dt>
            <dd className="text-heading">{date(a.endDate)}</dd>
            <dt className="text-muted">{t('hr.trainings.newEndDate')}</dt>
            <dd className="text-heading">{date(endDate)}</dd>
            <dt className="text-muted">{t('hr.trainings.extensionReason')}</dt>
            <dd dir="auto" className="whitespace-pre-line break-words text-heading">
              {reason.trim()}
            </dd>
          </dl>
          <p className="text-small text-muted">{t('hr.trainings.extendNote')}</p>
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
              {t('hr.trainings.confirm')}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={review} noValidate className="flex flex-col gap-4">
          <p className="text-small text-heading">
            {t('hr.trainings.currentEndDate')}: {date(a.endDate)}
          </p>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-date`}>
              {t('hr.trainings.newEndDate')}
            </label>
            <input
              id={`${id}-date`}
              type="date"
              className="ims-input"
              min={earliest}
              value={endDate}
              aria-invalid={dateProblem || undefined}
              aria-describedby={dateProblem ? `${id}-date-error` : undefined}
              onChange={(e) => setEndDate(e.target.value)}
            />
            {dateProblem && (
              <p id={`${id}-date-error`} role="alert" className="ims-error">
                {t(has('date') ? 'hr.trainings.errors.date' : 'hr.trainings.errors.notLater')}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-reason`}>
              {t('hr.trainings.extensionReason')}
            </label>
            <textarea
              id={`${id}-reason`}
              className="ims-input min-h-24"
              dir="auto"
              value={reason}
              maxLength={2000}
              aria-invalid={has('reason') || undefined}
              aria-describedby={has('reason') ? `${id}-reason-error` : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            {has('reason') && (
              <p id={`${id}-reason-error`} role="alert" className="ims-error">
                {t('hr.trainings.errors.reason')}
              </p>
            )}
          </div>
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

/** Every extension of a training, oldest first: dates, reason, HR user and time (HR only, NEW-35). */
function ExtensionHistoryDialog({
  assignment: a,
  onClose,
}: {
  assignment: HrAssignment;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  return (
    <Dialog open title={t('hr.trainings.historyTitle', { name: traineeName(a) })} onClose={onClose}>
      <ol className="flex flex-col gap-3">
        {(a.extensions ?? []).map((x: HrAssignmentExtension, index) => (
          <li key={`${x.extendedAt}-${index}`} className="ims-card flex flex-col gap-1 text-small">
            <p className="font-semibold text-heading">
              {date(x.previousEndDate)} → {date(x.newEndDate)}
            </p>
            <p dir="auto" className="whitespace-pre-line break-words">
              {x.reason}
            </p>
            <p className="text-muted">
              {t('hr.trainings.extendedBy', { name: x.extendedBy, date: date(x.extendedAt) })}
            </p>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex justify-end">
        <button type="button" className="ims-btn-outline" onClick={onClose}>
          {t('hr.trainings.close')}
        </button>
      </div>
    </Dialog>
  );
}
