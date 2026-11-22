import { useEffect, useId, useState, type FormEvent } from 'react';
import { useBlocker } from 'react-router';
import { Dialog } from '../../components/Dialog';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { evaluationApi } from './evaluationApi';
import type { EvaluationDetail, HiringRecommendation } from './models';

/** As PostgreSQL counts it (code points), like the server. */
export const COMMENT_MAX_LENGTH = 4000;
const SCORES = [1, 2, 3, 4, 5] as const;
const RECOMMENDATIONS: HiringRecommendation[] = ['Yes', 'Maybe', 'No'];

type Problem = 'conflict' | 'criteriaChanged' | 'alreadySubmitted' | 'failed';

/**
 * The shared final evaluation draft (R27 stage S2.2; AD-66, AD-68 G5/G8, owner decisions of 2026-11-22, AD-70), for the
 * training's final mentor and current responsible HR. A score from 1 to 5 per active criterion: a criterion never scored
 * starts unselected, a saved score is selected and can change but never be cleared (there is no "no score" option); an
 * optional comment and hiring recommendation. "Save draft" sends the revision it was loaded with: when the other
 * evaluator saved in between, nothing is overwritten; what was typed stays on screen and the latest version replaces it
 * only after an explicit confirmation. Only the last-saved time is shown, never who saved. No submission, no grade.
 */
export function DraftForm({
  evaluation,
  onSaved,
  onReload,
}: {
  evaluation: EvaluationDetail;
  onSaved: (evaluation: EvaluationDetail) => void;
  /** Loads the latest saved version (the caller remounts this form with it). */
  onReload: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const saved = evaluation.draft!;
  const [revision, setRevision] = useState(evaluation.revision ?? 0);
  const [baseline, setBaseline] = useState(saved);
  const [scores, setScores] = useState<Record<string, number>>(saved.scores);
  const [comment, setComment] = useState(saved.comment ?? '');
  const [recommendation, setRecommendation] = useState<HiringRecommendation | null>(
    saved.hiringRecommendation,
  );
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [commentTooLong, setCommentTooLong] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const commentLength = [...comment].length;
  const dirty =
    comment !== (baseline.comment ?? '') ||
    recommendation !== baseline.hiringRecommendation ||
    evaluation.criteria.some((c) => scores[c.id] !== baseline.scores[c.id]);

  // In-app navigation to another page while something is unsaved asks first (UAT 2026-11-22): stay, or leave and lose it.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );

  // Warn before leaving the page (reload, close, another site) while something is unsaved.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (commentLength > COMMENT_MAX_LENGTH) {
      setCommentTooLong(true);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const result = await evaluationApi.saveDraft(evaluation.applicationId, {
        revision,
        comment: comment.trim() === '' ? null : comment,
        hiringRecommendation: recommendation,
        // Only scored active criteria; a criterion never scored is left out (it stays unscored).
        scores: Object.fromEntries(
          evaluation.criteria
            .filter((c) => scores[c.id] !== undefined)
            .map((c) => [c.id, scores[c.id]!]),
        ),
      });
      const draft = result.draft!;
      setRevision(result.revision ?? revision);
      setBaseline(draft);
      setScores(draft.scores);
      setComment(draft.comment ?? '');
      setRecommendation(draft.hiringRecommendation);
      setJustSaved(true);
      onSaved(result);
    } catch (error) {
      const code = error instanceof ApiError && error.status === 409 ? error.code : undefined;
      setProblem(
        code === 'conflict.concurrent_update'
          ? 'conflict'
          : code === 'evaluation.criteria_changed'
            ? 'criteriaChanged'
            : code === 'evaluation.already_submitted'
              ? 'alreadySubmitted'
              : 'failed',
      );
    } finally {
      setSaving(false);
    }
  };

  const edited = () => setJustSaved(false);
  const status = saving
    ? t('evaluation.draft.saving')
    : dirty
      ? t('evaluation.draft.unsaved')
      : justSaved
        ? t('evaluation.draft.saved')
        : '';
  const stale = problem !== null && problem !== 'failed';

  return (
    <form onSubmit={(e) => void save(e)} noValidate className="flex flex-col gap-6">
      {evaluation.commentOnly ? (
        <p className="text-muted">{t('evaluation.commentOnly')}</p>
      ) : (
        <>
          <p className="text-small text-muted">{t('evaluation.draft.hint')}</p>
          {evaluation.criteria.map((c) => {
            // The interface language's name first, the other under it, each in its own language and direction.
            const arabic = { lang: 'ar', dir: 'rtl', text: c.nameAr } as const;
            const english = { lang: 'en', dir: 'ltr', text: c.nameEn } as const;
            const [main, other] = language === 'ar' ? [arabic, english] : [english, arabic];
            return (
              <fieldset key={c.id} className="rounded-card border border-border px-4 py-3">
                <legend className="flex flex-col px-1">
                  <span lang={main.lang} dir={main.dir} className="text-heading">
                    {main.text}
                  </span>
                  <span lang={other.lang} dir={other.dir} className="text-small text-muted">
                    {other.text}
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
          {t('evaluation.draft.comment')}
        </label>
        <textarea
          id={`${id}-comment`}
          className="ims-input min-h-32"
          dir="auto"
          value={comment}
          onChange={(event) => {
            setComment(event.target.value);
            setCommentTooLong(false);
            edited();
          }}
          aria-invalid={commentTooLong}
          aria-describedby={`${id}-count${commentTooLong ? ` ${id}-comment-error` : ''}`}
        />
        <p id={`${id}-count`} className="text-small text-muted" dir="ltr">
          {t('evaluation.draft.commentCount', { count: commentLength, max: COMMENT_MAX_LENGTH })}
        </p>
        {commentTooLong && (
          <p id={`${id}-comment-error`} role="alert" className="ims-error">
            {t('evaluation.draft.commentTooLong', { max: COMMENT_MAX_LENGTH })}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="ims-label mb-1">{t('evaluation.draft.recommendation')}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {[...RECOMMENDATIONS, null].map((value) => (
            <label key={value ?? 'none'} className="flex items-center gap-2">
              <input
                type="radio"
                name={`${id}-recommendation`}
                value={value ?? ''}
                checked={recommendation === value}
                onChange={() => {
                  setRecommendation(value);
                  edited();
                }}
              />
              {t(`evaluation.draft.recommendations.${value ?? 'none'}`)}
            </label>
          ))}
        </div>
      </fieldset>

      {problem && (
        <div role="alert" className="ims-error flex flex-col items-start gap-2">
          <p>
            {t(
              {
                conflict: 'evaluation.draft.conflict',
                criteriaChanged: 'evaluation.draft.criteriaChanged',
                alreadySubmitted: 'evaluation.draft.alreadySubmitted',
                failed: 'evaluation.draft.saveFailed',
              }[problem],
            )}
          </p>
          {stale && (
            <button type="button" className="ims-btn-outline" onClick={() => setConfirming(true)}>
              {t('evaluation.draft.loadLatest')}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="submit"
          className="ims-btn-primary"
          disabled={saving || problem === 'alreadySubmitted'}
        >
          {t('evaluation.draft.save')}
        </button>
        {dirty && !stale && (
          <button type="button" className="ims-btn-text" onClick={() => setConfirming(true)}>
            {t('evaluation.draft.discard')}
          </button>
        )}
        <span className="text-small text-muted" aria-live="polite">
          {status}
        </span>
      </div>
      {baseline.lastSavedAt && (
        <p className="text-small text-muted">
          {t('evaluation.draft.lastSaved', {
            time: new Date(baseline.lastSavedAt).toLocaleString(language),
          })}
        </p>
      )}

      <Dialog
        open={blocker.state === 'blocked'}
        title={t('evaluation.draft.leaveTitle')}
        onClose={() => blocker.reset?.()}
      >
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('evaluation.draft.leaveText')}</p>
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

      <Dialog
        open={confirming}
        title={t('evaluation.draft.confirmTitle')}
        onClose={() => setConfirming(false)}
      >
        <div className="flex flex-col gap-4">
          <p className="text-heading">{t('evaluation.draft.confirmText')}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ims-btn-text" onClick={() => setConfirming(false)}>
              {t('evaluation.draft.keepEditing')}
            </button>
            <button
              type="button"
              className="ims-btn-primary"
              onClick={() => {
                setConfirming(false);
                onReload();
              }}
            >
              {t('evaluation.draft.confirmDiscard')}
            </button>
          </div>
        </div>
      </Dialog>
    </form>
  );
}
