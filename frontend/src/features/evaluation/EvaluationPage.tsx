import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { DraftForm } from './DraftForm';
import { evaluationApi } from './evaluationApi';
import type { EvaluationDetail } from './models';

/**
 * One final evaluation (R27; AD-66): the training and the criteria the evaluation uses. While it is not submitted these
 * are the active criteria in their order, and its evaluators edit the shared draft (stage S2.2, `DraftForm`); once
 * submitted, it is read-only with the criteria frozen at submission. Without criteria the evaluation is a written comment
 * only. Submitting comes in a later stage; there is never a numeric average (AD-68 G8). A 404 says only "not found"
 * (G4: nothing about why).
 */
export function EvaluationPage({ base }: { base: string }) {
  const { t, language } = useI18n();
  const { applicationId = '' } = useParams();
  const [evaluation, setEvaluation] = useState<EvaluationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to load the latest saved version again (after a conflict). The shown version is cleared first, so the draft
  // form mounts again only with the version just loaded.
  const [loads, setLoads] = useState(0);
  const reload = useCallback(() => {
    setEvaluation(null);
    setLoads((n) => n + 1);
  }, []);

  useEffect(() => {
    let current = true;
    evaluationApi.get(applicationId).then(
      (value) => current && setEvaluation(value),
      (failure: unknown) => {
        if (!current) return;
        const status = failure instanceof ApiError ? failure.status : 0;
        setError(
          status === 404
            ? 'evaluation.notFound'
            : status === 409
              ? 'evaluation.notAvailable'
              : 'training.errors.loadFailed',
        );
      },
    );
    return () => {
      current = false;
    };
  }, [applicationId, loads]);

  const back = (
    <Link to={base} className="ims-btn-text mb-4 inline-flex">
      {t('evaluation.back')}
    </Link>
  );
  if (error) {
    return (
      <>
        {back}
        <p role="alert" className="ims-state">
          {t(error)}
        </p>
      </>
    );
  }
  if (!evaluation) return back;

  const e = evaluation;
  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const submitted = e.status === 'Submitted';
  const editable = !submitted && e.draft !== undefined;
  const item = (label: string, value: string) => (
    <div>
      <dt className="text-small text-muted">{t(label)}</dt>
      <dd className="text-heading">{value}</dd>
    </div>
  );

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="ims-page-title">{e.traineeName ?? t('evaluation.traineeUnnamed')}</h1>
        <span className="ims-badge whitespace-nowrap">{t(`evaluation.statuses.${e.status}`)}</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="ims-card" aria-labelledby="evaluation-training">
          <h2 id="evaluation-training" className="mb-4 text-h3 font-semibold text-heading">
            {t('evaluation.training')}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            {item('training.fields.field', e.fieldName)}
            {item('evaluation.period', `${date(e.startDate)} – ${date(e.endDate)}`)}
            {item('evaluation.endStatus', t(`training.assignmentStatus.${e.endStatus}`))}
            {item(
              'evaluation.capacity',
              e.capacities
                .map((c) => t(`evaluation.capacities.${c}`))
                .join(t('evaluation.listSeparator')),
            )}
          </dl>
        </section>

        <section className="ims-card" aria-labelledby="evaluation-criteria">
          <h2 id="evaluation-criteria" className="mb-4 text-h3 font-semibold text-heading">
            {t('evaluation.criteria')}
          </h2>
          {editable ? (
            <DraftForm key={loads} evaluation={e} onSaved={setEvaluation} onReload={reload} />
          ) : (
            <>
              {e.commentOnly ? (
                <p className="text-muted">
                  {t(submitted ? 'evaluation.commentOnlySubmitted' : 'evaluation.commentOnly')}
                </p>
              ) : (
                <>
                  {submitted && (
                    <p className="mb-3 text-small text-muted">{t('evaluation.frozen')}</p>
                  )}
                  <ol aria-labelledby="evaluation-criteria" className="flex flex-col gap-2">
                    {e.criteria.map((c) => {
                      // The interface language's name first, the other under it, each in its own language and direction.
                      const arabic = { lang: 'ar', dir: 'rtl', text: c.nameAr } as const;
                      const english = { lang: 'en', dir: 'ltr', text: c.nameEn } as const;
                      const [main, other] =
                        language === 'ar' ? [arabic, english] : [english, arabic];
                      return (
                        <li
                          key={c.id}
                          className="flex flex-col rounded-card border border-border px-4 py-2"
                        >
                          <span lang={main.lang} dir={main.dir} className="text-heading">
                            {main.text}
                          </span>
                          <span lang={other.lang} dir={other.dir} className="text-small text-muted">
                            {other.text}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}
              <p className="mt-4 text-small text-muted">{t('evaluation.readOnly')}</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
