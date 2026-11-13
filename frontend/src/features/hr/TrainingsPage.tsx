import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { hrApi } from './hrApi';
import type {
  AssignmentStatus,
  HrAssignment,
  HrAssignmentExtension,
  HrMentor,
  HrTransferDecision,
} from './models';

/**
 * HR: the trainings (assignments) as recorded (PDF §4 "running training"). Current = Active (AD-49); every other status
 * is listed as previous, with the reason HR recorded. HR ends a current training (AD-63 Phase 1): a successful
 * completion (Completed on or after the planned end date, Ended early before it, with a reason) or the trainee's
 * withdrawal (with a reason), on an actual end date between the start and today (Asia/Hebron). HR also extends a
 * current training (AD-63 L2, NEW-35): a later planned end date with a reason, any number of times; every extension is
 * kept and listed in its history (HR only). The application's current responsible HR (AD-64) transfers a current
 * training to another mentor (AD-65), with a reason: today (at once) or from a later date (scheduled; the current mentor
 * stays responsible until then), and may cancel a scheduled transfer with a reason. Both assignments of an executed
 * transfer stay listed with the link between them, and every transfer decision is kept. Reopening is not built.
 */
export function TrainingsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [assignments, setAssignments] = useState<HrAssignment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ending, setEnding] = useState<HrAssignment | null>(null);
  const [extending, setExtending] = useState<HrAssignment | null>(null);
  const [showingHistory, setShowingHistory] = useState<HrAssignment | null>(null);
  const [transferring, setTransferring] = useState<HrAssignment | null>(null);
  const [cancellingTransfer, setCancellingTransfer] = useState<HrAssignment | null>(null);
  const [showingTransfers, setShowingTransfers] = useState<HrAssignment | null>(null);

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
        onTransfer={setTransferring}
        onCancelTransfer={setCancellingTransfer}
        onHistory={setShowingHistory}
        onTransfers={setShowingTransfers}
      />
      <TrainingTable
        id="previous-trainings"
        title={t('hr.trainings.previous')}
        empty={t('hr.trainings.noPrevious')}
        rows={previous}
        showReason
        onHistory={setShowingHistory}
        onTransfers={setShowingTransfers}
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
          onConflict={(message) => {
            setEnding(null);
            toast(message);
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
          onConflict={(message) => {
            setExtending(null);
            toast(message);
            void load();
          }}
        />
      )}
      {transferring && (
        <TransferTrainingDialog
          assignment={transferring}
          onClose={() => setTransferring(null)}
          onTransferred={(scheduled) => {
            setTransferring(null);
            toast(scheduled ? 'hr.trainings.transferScheduled' : 'hr.trainings.transferred');
            void load();
          }}
          onRefused={(message) => {
            setTransferring(null);
            toast(message);
            void load();
          }}
        />
      )}
      {cancellingTransfer && (
        <CancelTransferDialog
          assignment={cancellingTransfer}
          onClose={() => setCancellingTransfer(null)}
          onDone={(message) => {
            setCancellingTransfer(null);
            toast(message);
            void load();
          }}
        />
      )}
      {showingTransfers && (
        <TransferDecisionsDialog
          assignment={showingTransfers}
          onClose={() => setShowingTransfers(null)}
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
  onTransfer,
  onCancelTransfer,
  onHistory,
  onTransfers,
  showReason = false,
}: {
  id: string;
  title: string;
  empty: string;
  rows: HrAssignment[];
  onEnd?: (assignment: HrAssignment) => void;
  onExtend?: (assignment: HrAssignment) => void;
  onTransfer?: (assignment: HrAssignment) => void;
  onCancelTransfer?: (assignment: HrAssignment) => void;
  onHistory?: (assignment: HrAssignment) => void;
  onTransfers?: (assignment: HrAssignment) => void;
  showReason?: boolean;
}) {
  const { t, language } = useI18n();
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const hasHistory = (a: HrAssignment) => (a.extensions?.length ?? 0) > 0;
  const hasTransfers = (a: HrAssignment) => (a.transferDecisions?.length ?? 0) > 0;
  const pending = (a: HrAssignment) => a.transferDecisions?.find((d) => d.status === 'Pending');
  const showActions = Boolean(
    onEnd ||
    onExtend ||
    (onHistory && rows.some(hasHistory)) ||
    (onTransfers && rows.some(hasTransfers)),
  );
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
                  <td>
                    {a.employee.fullName}
                    {a.transferredFrom && (
                      <span className="block text-small text-muted">
                        {t('hr.trainings.transferredFrom', {
                          name: a.transferredFrom.employeeName,
                        })}
                      </span>
                    )}
                    {a.transferredTo && (
                      <span className="block text-small text-muted">
                        {t('hr.trainings.transferredTo', { name: a.transferredTo.employeeName })}
                      </span>
                    )}
                    {pending(a) && (
                      <span className="ims-badge mt-1">
                        {t('hr.trainings.scheduledTransfer', {
                          name: pending(a)!.incomingEmployeeName,
                          date: date(pending(a)!.effectiveDate),
                        })}
                      </span>
                    )}
                  </td>
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
                        {onTransfer && a.canTransfer && (
                          <button
                            type="button"
                            className="ims-btn-outline"
                            aria-label={t('hr.trainings.transferFor', { name: traineeName(a) })}
                            onClick={() => onTransfer(a)}
                          >
                            {t('hr.trainings.transfer')}
                          </button>
                        )}
                        {onCancelTransfer && a.canCancelTransfer && (
                          <button
                            type="button"
                            className="ims-btn-outline"
                            aria-label={t('hr.trainings.cancelTransferFor', {
                              name: traineeName(a),
                            })}
                            onClick={() => onCancelTransfer(a)}
                          >
                            {t('hr.trainings.cancelTransfer')}
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
                        {onTransfers && hasTransfers(a) && (
                          <button
                            type="button"
                            className="ims-btn-text"
                            aria-label={t('hr.trainings.transferDecisionsFor', {
                              name: traineeName(a),
                            })}
                            onClick={() => onTransfers(a)}
                          >
                            {t('hr.trainings.transferDecisions', {
                              count: a.transferDecisions?.length ?? 0,
                            })}
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
  /** A 409: the toast to show (a transfer due today, AD-65, or a concurrent change). */
  onConflict: (message: string) => void;
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
      if (error instanceof ApiError && error.status === 409)
        return onConflict(conflictMessage(error));
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
  /** A 409: the toast to show (a transfer due today, AD-65, or a concurrent change). */
  onConflict: (message: string) => void;
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
      if (error instanceof ApiError && error.status === 409)
        return onConflict(conflictMessage(error));
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

/** The toast for a 409 on a training: a transfer that takes effect today waits for its scheduled run (AD-65). */
function conflictMessage(error: ApiError): string {
  return error.code === 'assignment.transfer_due'
    ? 'hr.trainings.errors.transferDue'
    : 'training.errors.conflict';
}

type TransferProblem =
  | 'mentor'
  | 'date'
  | 'notAfterStart'
  | 'inPast'
  | 'afterEnd'
  | 'reason'
  | 'mentorNotEmployee';

const TRANSFER_PROBLEMS: Record<string, TransferProblem> = {
  'assignment.transfer_not_after_start': 'notAfterStart',
  'assignment.transfer_in_past': 'inPast',
  'assignment.transfer_after_end': 'afterEnd',
  'assignment.transfer_same_mentor': 'mentor',
  'assignment.transfer_mentor_not_employee': 'mentorNotEmployee',
};

/**
 * AD-65: the current responsible HR transfers a current training to another mentor (a user who holds the Employee role
 * now; no approval from them), with a reason. The date (Asia/Hebron) is today (an immediate transfer) or later (a
 * scheduled one: the current mentor stays responsible until then), never earlier; after the start date and not after
 * the planned end date. The current mentor's assignment ends the day before; the new one keeps the planned end date as it
 * is on that date. Reviewed, then confirmed once.
 */
function TransferTrainingDialog({
  assignment: a,
  onClose,
  onTransferred,
  onRefused,
}: {
  assignment: HrAssignment;
  onClose: () => void;
  /** `scheduled`: the transfer takes effect on a later date. */
  onTransferred: (scheduled: boolean) => void;
  onRefused: (message: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const today = hebronToday();
  const afterStart = addDays(a.startDate, 1);
  const earliest = afterStart > today ? afterStart : today;
  const [mentors, setMentors] = useState<HrMentor[] | null>(null);
  const [mentorsFailed, setMentorsFailed] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [transferDate, setTransferDate] = useState('');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<TransferProblem[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const has = (problem: TransferProblem) => problems.includes(problem);
  const mentorProblem = has('mentor') || has('mentorNotEmployee');
  const dateProblem = has('date') || has('notAfterStart') || has('inPast') || has('afterEnd');
  const dateMessage = has('date')
    ? 'hr.trainings.errors.date'
    : has('inPast')
      ? 'hr.trainings.errors.transferInPast'
      : has('notAfterStart')
        ? 'hr.trainings.errors.transferNotAfterStart'
        : 'hr.trainings.errors.transferAfterEnd';
  const scheduled = transferDate > today;

  useEffect(() => {
    let active = true;
    hrApi.mentors().then(
      // The current mentor cannot be the incoming one.
      (all) => active && setMentors(all.filter((m) => m.id !== a.employee.id)),
      () => active && setMentorsFailed(true),
    );
    return () => {
      active = false;
    };
  }, [a.employee.id]);

  const chosen = mentors?.find((m) => m.id === employeeId) ?? null;

  const review = (event: FormEvent) => {
    event.preventDefault();
    const found: TransferProblem[] = [];
    if (!chosen) found.push('mentor');
    if (!transferDate) found.push('date');
    else if (transferDate < today) found.push('inPast');
    else if (transferDate <= a.startDate) found.push('notAfterStart');
    else if (transferDate > a.endDate) found.push('afterEnd');
    if (reason.trim() === '') found.push('reason');
    setProblems(found);
    setFailed(false);
    if (found.length === 0) setReviewing(true);
  };

  const confirm = async () => {
    if (!chosen || submitting.current) return; // one submission at a time
    submitting.current = true;
    setBusy(true);
    try {
      await hrApi.transferAssignment(a.id, chosen.id, transferDate, reason.trim());
      onTransferred(scheduled);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        return onRefused(
          error.code === 'assignment.transfer_pending'
            ? 'hr.trainings.errors.transferPending'
            : conflictMessage(error),
        );
      if (error instanceof ApiError && error.status === 403)
        return onRefused('hr.trainings.errors.transferNotResponsible');
      const problem =
        error instanceof ApiError && error.code ? TRANSFER_PROBLEMS[error.code] : undefined;
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
      title={t('hr.trainings.transferTitle', { name: traineeName(a) })}
      onClose={busy ? () => {} : onClose}
    >
      {reviewing && chosen ? (
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('hr.trainings.reviewIntro')}</p>
          <dl className="grid gap-x-4 gap-y-2 text-small sm:grid-cols-2">
            <dt className="text-muted">{t('hr.trainings.trainee')}</dt>
            <dd className="text-heading">{traineeName(a)}</dd>
            <dt className="text-muted">{t('hr.trainings.currentMentor')}</dt>
            <dd className="text-heading">{a.employee.fullName}</dd>
            <dt className="text-muted">{t('hr.trainings.newMentor')}</dt>
            <dd className="text-heading">{chosen.fullName}</dd>
            <dt className="text-muted">{t('hr.trainings.transferType')}</dt>
            <dd className="text-heading">
              {scheduled
                ? t('hr.trainings.typeScheduled', { date: date(transferDate) })
                : t('hr.trainings.typeImmediate')}
            </dd>
            <dt className="text-muted">{t('hr.trainings.transferDate')}</dt>
            <dd className="text-heading">{date(transferDate)}</dd>
            <dt className="text-muted">{t('hr.trainings.currentMentorUntil')}</dt>
            <dd className="text-heading">{date(addDays(transferDate, -1))}</dd>
            <dt className="text-muted">{t('hr.trainings.plannedEndKept')}</dt>
            <dd className="text-heading">{date(a.endDate)}</dd>
            <dt className="text-muted">{t('hr.trainings.transferReason')}</dt>
            <dd dir="auto" className="whitespace-pre-line break-words text-heading">
              {reason.trim()}
            </dd>
          </dl>
          <p className="text-small text-muted">
            {scheduled
              ? t('hr.trainings.transferScheduledHint', { date: date(transferDate) })
              : t('hr.trainings.transferImmediate')}
          </p>
          <p className="text-small text-muted">{t('hr.trainings.transferNote')}</p>
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
          <dl className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-2">
            <dt className="text-muted">{t('hr.trainings.currentMentor')}</dt>
            <dd className="text-heading">{a.employee.fullName}</dd>
            <dt className="text-muted">{t('hr.trainings.plannedEndKept')}</dt>
            <dd className="text-heading">{date(a.endDate)}</dd>
          </dl>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-mentor`}>
              {t('hr.trainings.newMentor')}
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
              <p className="text-small text-muted">{t('hr.trainings.noMentors')}</p>
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
                    ? 'hr.trainings.errors.mentorNotEmployee'
                    : 'hr.trainings.errors.mentor',
                )}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-date`}>
              {t('hr.trainings.transferDate')}
            </label>
            <input
              id={`${id}-date`}
              type="date"
              className="ims-input"
              min={earliest}
              max={a.endDate}
              value={transferDate}
              aria-invalid={dateProblem || undefined}
              aria-describedby={
                dateProblem ? `${id}-date-error ${id}-date-hint` : `${id}-date-hint`
              }
              onChange={(e) => setTransferDate(e.target.value)}
            />
            <p id={`${id}-date-hint`} className="text-small text-muted">
              {!transferDate || transferDate < today
                ? t('hr.trainings.transferDateHint')
                : scheduled
                  ? t('hr.trainings.transferScheduledHint', { date: date(transferDate) })
                  : t('hr.trainings.transferImmediate')}
            </p>
            {dateProblem && (
              <p id={`${id}-date-error`} role="alert" className="ims-error">
                {t(dateMessage)}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="ims-label" htmlFor={`${id}-reason`}>
              {t('hr.trainings.transferReason')}
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

/**
 * AD-65: the current responsible HR cancels the pending transfer of a current training, with a mandatory reason. The
 * decision is kept (Cancelled); another date or mentor is a new transfer. Confirmed once.
 */
function CancelTransferDialog({
  assignment: a,
  onClose,
  onDone,
}: {
  assignment: HrAssignment;
  onClose: () => void;
  /** The toast to show; the page reloads. */
  onDone: (message: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const decision = a.transferDecisions?.find((d) => d.status === 'Pending');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const date = (value: string) => new Date(value).toLocaleDateString(language);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() === '') {
      setMissing(true);
      return;
    }
    if (!decision || submitting.current) return; // one submission at a time
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await hrApi.cancelTransfer(decision.id, reason.trim());
      onDone('hr.trainings.transferCancelled');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403)
        return onDone('hr.trainings.errors.transferNotResponsible');
      if (error instanceof ApiError && error.code === 'transfer_decision.invalid_status')
        return onDone('hr.trainings.errors.transferNotPending');
      if (error instanceof ApiError && error.status === 409) return onDone(conflictMessage(error));
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t('hr.trainings.cancelTransferTitle', { name: traineeName(a) })}
      onClose={busy ? () => {} : onClose}
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        {decision && (
          <p className="text-heading">
            {t('hr.trainings.scheduledTransfer', {
              name: decision.incomingEmployeeName,
              date: date(decision.effectiveDate),
            })}
          </p>
        )}
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-reason`}>
            {t('hr.trainings.cancelReason')}
          </label>
          <textarea
            id={`${id}-reason`}
            className="ims-input min-h-24"
            dir="auto"
            value={reason}
            maxLength={2000}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? `${id}-reason-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {missing && (
            <p id={`${id}-reason-error`} role="alert" className="ims-error">
              {t('hr.trainings.errors.reason')}
            </p>
          )}
        </div>
        <p className="text-small text-muted">{t('hr.trainings.cancelTransferNote')}</p>
        {failed && (
          <p role="alert" className="ims-error">
            {t('training.errors.generic')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="ims-btn-text" disabled={busy} onClick={onClose}>
            {t('hr.trainings.keepTransfer')}
          </button>
          <button type="submit" className="ims-btn-primary" disabled={busy}>
            {t('hr.trainings.confirmCancelTransfer')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** AD-65: every transfer decision taken from an assignment, oldest first, with its status and outcome (HR only). */
function TransferDecisionsDialog({
  assignment: a,
  onClose,
}: {
  assignment: HrAssignment;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const outcome = (d: HrTransferDecision) => {
    if (!d.resolvedAt) return null;
    if (d.status === 'Executed') return t('hr.trainings.executedOn', { date: date(d.resolvedAt) });
    if (d.status === 'Cancelled')
      return t('hr.trainings.cancelledBy', { name: d.resolvedBy ?? '', date: date(d.resolvedAt) });
    return t('hr.trainings.voidedOn', {
      date: date(d.resolvedAt),
      reason: t(`hr.trainings.voidReasons.${d.resolutionCode ?? 'dates_invalid'}`),
    });
  };
  return (
    <Dialog
      open
      title={t('hr.trainings.transferDecisionsTitle', { name: traineeName(a) })}
      onClose={onClose}
    >
      <ol className="flex flex-col gap-3">
        {(a.transferDecisions ?? []).map((d) => (
          <li key={d.id} className="ims-card flex flex-col gap-1 text-small">
            <p className="flex flex-wrap items-center gap-2 font-semibold text-heading">
              <span className="ims-badge">{t(`hr.trainings.decisionStatus.${d.status}`)}</span>
              {t('hr.trainings.decisionTarget', {
                name: d.incomingEmployeeName,
                date: date(d.effectiveDate),
              })}
            </p>
            <p dir="auto" className="whitespace-pre-line break-words">
              {d.reason}
            </p>
            <p className="text-muted">
              {t('hr.trainings.decidedBy', { name: d.decidedBy, date: date(d.decidedAt) })}
            </p>
            {outcome(d) && <p className="text-muted">{outcome(d)}</p>}
            {d.status === 'Cancelled' && d.resolutionReason && (
              <p dir="auto" className="whitespace-pre-line break-words">
                {d.resolutionReason}
              </p>
            )}
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
