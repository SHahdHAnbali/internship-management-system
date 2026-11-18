import { useState } from 'react';
import { Switch } from '../../components/Switch';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { CriterionDialog } from './CriterionDialog';
import { useAdminFeedback } from './feedback';
import type { CreateEvaluationCriterionRequest, EvaluationCriterion } from './models';
import { useLoad } from './useLoad';

/**
 * Admin: manage the evaluation criteria (AD-66): Arabic and English names and the active flag; no weights. The order is
 * assigned automatically and never changes (AD-68 G7), so it is shown but not edited. Criteria are deactivated, never deleted.
 */
export function CriteriaPage() {
  const { t, language } = useI18n();
  const feedback = useAdminFeedback();
  const {
    data: criteria,
    loading,
    failed,
    reload,
  } = useLoad('criteria', adminApi.listCriteria, feedback.error);
  const [editing, setEditing] = useState<EvaluationCriterion | null | 'new'>(null);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      feedback.saved();
    } catch (error) {
      feedback.error(error);
    }

    await reload();
  };

  const save = (value: CreateEvaluationCriterionRequest) => {
    const target = editing;
    setEditing(null);
    void run(() =>
      target === 'new' || target === null
        ? adminApi.createCriterion(value)
        : adminApi.updateCriterion(target.id, { ...value, isActive: target.isActive }),
    );
  };

  return (
    <>
      <PageHeader title={t('admin.criteria.title')}>
        <button type="button" className="ims-btn-primary" onClick={() => setEditing('new')}>
          {t('admin.criteria.add')}
        </button>
      </PageHeader>

      {failed ? (
        <p className="ims-state">{t('admin.errors.loadFailed')}</p>
      ) : !loading && criteria?.length === 0 ? (
        <p className="ims-state">{t('admin.criteria.empty')}</p>
      ) : (
        criteria && (
          // `relative`: on a phone this table scrolls inside its card; the card must also clip the sr-only header.
          <div className="ims-table-card relative">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.criteria.order')}</th>
                  <th scope="col">{t('admin.criteria.nameAr')}</th>
                  <th scope="col">{t('admin.criteria.nameEn')}</th>
                  <th scope="col">{t('admin.criteria.active')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.actions.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {criteria.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sortOrder}</td>
                    <td>
                      <span lang="ar" dir="rtl">
                        {c.nameAr}
                      </span>
                    </td>
                    <td>
                      <span lang="en" dir="ltr">
                        {c.nameEn}
                      </span>
                    </td>
                    <td>
                      <Switch
                        checked={c.isActive}
                        label={`${t('admin.criteria.active')}: ${language === 'ar' ? c.nameAr : c.nameEn}`}
                        onChange={(isActive) =>
                          void run(() =>
                            adminApi.updateCriterion(c.id, {
                              nameAr: c.nameAr,
                              nameEn: c.nameEn,
                              isActive,
                            }),
                          )
                        }
                      />
                    </td>
                    <td className="text-end">
                      <button type="button" className="ims-btn-text" onClick={() => setEditing(c)}>
                        {t('admin.actions.edit')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {editing !== null && (
        <CriterionDialog
          criterion={editing === 'new' ? null : editing}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
