import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../auth/context';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { COMMENT_MAX_LENGTH } from './DraftForm';
import { evaluationApi } from './evaluationApi';
import type { CorrectionStart, HiringRecommendation } from './models';

/** As PostgreSQL counts it (code points), like the server. */
export const REASON_MAX_LENGTH = 2000;
const SCORES = [1, 2, 3, 4, 5] as const;
const RECOMMENDATIONS: HiringRecommendation[] = ['Yes', 'Maybe', 'No'];

type Problem = 'noChanges' | 'conflict' | 'unavailable' | 'invalid' | 'uncertain';
const RELOAD_AFTER: Problem[] = ['conflict', 'uncertain'];

const length = (text: string) => [...text].length;

/**
 * Correcting a submitted final evaluation (R27 stage S2.4; owner decisions of 2026-11-23, AD-72), for the training's final
 * mentor and current responsible HR, on a page of its own (the submitted evaluation stays read-only). It starts from
 * the current values: a score from 1 to 5 for every frozen criterion (names and order never change), the comment and the
 * recommendation, all required; plus an optional reason. Only a real change of a score, the comment or the
 * recommendation can be saved (a reason alone is not one). An explicit confirmation sends it once (the buttons are
 * disabled meanwhile; never retried automatically). A newer version loads only on request; a lost right to correct
 * disables saving. Saved: back to the read-only evaluation. There is no correction draft and no history here.
 */
export function CorrectionPage({ base }: { base: string }) {
  const { t, language } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const id = useId();
  const { applicationId = '' } = useParams();
  const [start, setStart] = useState<CorrectionStart | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [recommendation, setRecommendation] = useState<HiringRecommendation>('Yes');
  const [reason, setReason] = useState('');
  const [commentError, setCommentError] = useState<'required' | 'tooLong' | null>(null);
  const [reasonTooLong, setReasonTooLong] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  // Set once saved: leaving for the read-only page then never asks about unsaved changes.
  const done = useRef(false);

  // An expired session (401): nothing here is shown or retried; the sign-in check (AuthProvider) learns it is signed out
  // and the area's guard sends the user to sign in. Leaving then never asks about unsaved changes.
  const sessionEnded = useCallback(() => {
    done.current = true;
    void refresh();
  }, [refresh]);

  const reload = useCallback(() => {
    setStart(null);
    setProblem(null);
    setLoads((n) => n + 1);
  }, []);

  useEffect(() => {
    let current = true;
    evaluationApi.correction(applicationId).then(
      (value) => {
        if (!current) return;
        setStart(value);
        setScores(value.scores);
        setComment(value.comment);
        setRecommendation(value.hiringRecommendation);
        setReason('');
        setCommentError(null);
        setReasonTooLong(false);
      },
      (failure: unknown) => {
        if (!current) return;
        const status = failure instanceof ApiError ? failure.status : 0;
        if (status === 401) return sessionEnded();
        setLoadError(
          status === 404
            ? 'evaluation.notFound'
            : status === 403 || status === 409
              ? 'evaluation.correction.unavailable'
              : 'training.errors.loadFailed',
        );
      },
    );
    return () => {
      current = false;
    };
  }, [applicationId, loads, sessionEnded]);

  // A real change (what the server also checks): the reason is never one, and the comment is compared trimmed.
  const changed =
    start !== null &&
    (comment.trim() !== start.comment ||
      recommendation !== start.hiringRecommendation ||
      start.criteria.some((c) => scores[c.id] !== start.scores[c.id]));
  const dirty = start !== null && (changed || comment !== start.comment || reason.trim() !== '');

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !done.current && dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const readOnlyPage = `${base}/${encodeURIComponent(applicationId)}`;
  const back = (
    <Link to={readOnlyPage} className="ims-btn-text mb-4 inline-flex">
      {t('evaluation.correction.cancelEdit')}
    </Link>
  );
  if (loadError) {
    return (
      <>
        {back}
        <p role="alert" className="ims-state">
          {t(loadError)}
        </p>
      </>
    );
  }
  if (!start) return back;

  const edited = () => {
    if (problem === 'noChanges' || problem === 'invalid') setProblem(null);
  };

  const requestSave = (event: FormEvent) => {
    event.preventDefault();
    if (saving || problem === 'unavailable' || problem === 'conflict') return; // nothing to resend as is
    const commentProblem =
      comment.trim() === ''
        ? 'required'
        : length(comment.trim()) > COMMENT_MAX_LENGTH
          ? 'tooLong'
          : null;
    const reasonProblem = length(reason.trim()) > REASON_MAX_LENGTH;
    setCommentError(commentProblem);
    setReasonTooLong(reasonProblem);
    if (commentProblem || reasonProblem) return;
    if (!changed) return setProblem('noChanges');
    setProblem(null);
    setConfirming(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await evaluationApi.correct(applicationId, {
        revision: start.revision,
        comment: comment.trim(),
        hiringRecommendation: recommendation,
        scores: Object.fromEntries(start.criteria.map((c) => [c.id, scores[c.id]!])),
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      done.current = true;
      setConfirming(false);
      toast('evaluation.correction.success');
      void navigate(readOnlyPage, { replace: true });
    } catch (error) {
      setConfirming(false);
      const status = error instanceof ApiError ? error.status : 0;
      const code = error instanceof ApiError ? error.code : undefined;
      if (status === 401) return sessionEnded();
      setProblem(
        status === 409 && code === 'evaluation.no_changes'
          ? 'noChanges'
          : status === 409 && code === 'conflict.concurrent_update'
            ? 'conflict'
            : status === 403 || status === 404 || status === 409
              ? 'unavailable' // the right to correct, or the evaluation's state, changed: nothing to retry here
              : status === 400
                ? 'invalid'
                : 'uncertain', // not confirmed either way: load the latest to see, never resend automatically
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {back}
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="ims-page-title">{t('evaluation.correction.title')}</h1>
        <p className="text-muted">{start.traineeName ?? t('evaluation.traineeUnnamed')}</p>
      </div>

      <form
        onSubmit={requestSave}
        noValidate
        className="ims-card flex max-w-content flex-col gap-6"
        aria-labelledby={`${id}-title`}
      >
        <h2 id={`${id}-title`} className="text-h3 font-semibold text-heading">
          {t('evaluation.criteria')}
        </h2>
        {start.commentOnly ? (
          <p className="text-muted">{t('evaluation.commentOnlySubmitted')}</p>
        ) : (
          <>
            <p className="text-small text-muted">{t('evaluation.frozen')}</p>
            {start.criteria.map((c) => {
              const arabic = { lang: 'ar', dir: 'rtl', text: c.nameAr } as const;
              const english = { lang: 'en', dir: 'ltr', text: c.nameEn } as const;
              const [main, other] = language === 'ar' ? [arabic, english] : [english, arabic];
              return (
                <fieldset key={c.id} className="rounded-card border border-border px-4 py-3">
                  <legend className="flex flex-col items-start px-1">
                    <span className="text-heading">
                      <span lang={main.lang} dir={main.dir}>
                        {main.text}
                      </span>
                    </span>
                    <span className="text-small text-muted">
                      <span lang={other.lang} dir={other.dir}>
                        {other.text}
                      </span>
                    </span>
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                    {SCORES.map((score) => (
                      <label key={score} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`${id}-score-${c.id}`}
                          value={score}
                          checked={scores[c.id] === score}
                          onChange={() => {
                            setScores((now) => ({ ...now, [c.id]: score }));
                            edited();
                          }}
                        />
                        {score}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </>
        )}

        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-comment`}>
            {t('evaluation.correction.comment')}
          </label>
          <textarea
            id={`${id}-comment`}
            className="ims-input min-h-32"
            dir="auto"
            required
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
              setCommentError(null);
              edited();
            }}
            aria-invalid={commentError !== null}
            aria-describedby={`${id}-comment-count${commentError ? ` ${id}-comment-error` : ''}`}
          />
          <p id={`${id}-comment-count`} className="text-small text-muted" dir="ltr">
            {t('evaluation.draft.commentCount', {
              count: length(comment),
              max: COMMENT_MAX_LENGTH,
            })}
          </p>
          {commentError && (
            <p id={`${id}-comment-error`} role="alert" className="ims-error">
              {commentError === 'required'
                ? t('evaluation.correction.commentRequired')
                : t('evaluation.draft.commentTooLong', { max: COMMENT_MAX_LENGTH })}
            </p>
          )}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="ims-label mb-1">{t('evaluation.correction.recommendation')}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {RECOMMENDATIONS.map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-recommendation`}
                  value={value}
                  checked={recommendation === value}
                  onChange={() => {
                    setRecommendation(value);
                    edited();
                  }}
                />
                {t(`evaluation.draft.recommendations.${value}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-reason`}>
            {t('evaluation.correction.reason')}
          </label>
          <textarea
            id={`${id}-reason`}
            className="ims-input min-h-24"
            dir="auto"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonTooLong(false);
            }}
            aria-invalid={reasonTooLong}
            aria-describedby={`${id}-reason-count${reasonTooLong ? ` ${id}-reason-error` : ''}`}
          />
          <p id={`${id}-reason-count`} className="text-small text-muted" dir="ltr">
            {t('evaluation.correction.reasonCount', {
              count: length(reason),
              max: REASON_MAX_LENGTH,
            })}
          </p>
          {reasonTooLong && (
            <p id={`${id}-reason-error`} role="alert" className="ims-error">
              {t('evaluation.correction.reasonTooLong', { max: REASON_MAX_LENGTH })}
            </p>
          )}
        </div>

        {problem && (
          <div
            id={`${id}-problem`}
            role="alert"
            className="ims-error flex flex-col items-start gap-2"
          >
            <p>{t(`evaluation.correction.${problem}`)}</p>
            {RELOAD_AFTER.includes(problem) && (
              <button type="button" className="ims-btn-outline" onClick={reload}>
                {t('evaluation.correction.reload')}
              </button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="submit"
            className="ims-btn-primary"
            disabled={saving}
            aria-disabled={problem === 'unavailable' || problem === 'conflict'}
            aria-describedby={problem ? `${id}-problem` : undefined}
          >
            {saving ? t('evaluation.correction.saving') : t('evaluation.correction.save')}
          </button>
        </div>
      </form>

      <Dialog
        open={confirming}
        title={t('evaluation.correction.confirmTitle')}
        onClose={() => {
          if (!saving) setConfirming(false);
        }}
      >
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('evaluation.correction.confirmText')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="ims-btn-text"
              disabled={saving}
              onClick={() => setConfirming(false)}
            >
              {t('evaluation.correction.cancel')}
            </button>
            <button
              type="button"
              className="ims-btn-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? t('evaluation.correction.saving') : t('evaluation.correction.save')}
            </button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={blocker.state === 'blocked'}
        title={t('evaluation.draft.leaveTitle')}
        onClose={() => blocker.reset?.()}
      >
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('evaluation.correction.leaveText')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ims-btn-text" onClick={() => blocker.reset?.()}>
              {t('evaluation.draft.stay')}
            </button>
            <button type="button" className="ims-btn-primary" onClick={() => blocker.proceed?.()}>
              {t('evaluation.draft.leave')}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
