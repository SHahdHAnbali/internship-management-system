import { useState } from 'react';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { CriterionDialog } from './CriterionDialog';
import { useAdminFeedback } from './feedback';
import type { EvaluationCriterion, SaveEvaluationCriterionRequest } from './models';
import { useLoad } from './useLoad';

/** Admin: manage the evaluation criteria and their weights (PDF §4, §8). */
export function CriteriaPage() {
  const { t } = useI18n();
  const feedback = useAdminFeedback();
  const {
    data: criteria,
    loading,
    failed,
    reload,
  } = useLoad('criteria', adminApi.listCriteria, feedback.error);
  const [editing, setEditing] = useState<EvaluationCriterion | null | 'new'>(null);

  const save = async (value: SaveEvaluationCriterionRequest) => {
    const target = editing;
    setEditing(null);
    try {
      await (target === 'new' || target === null
        ? adminApi.createCriterion(value)
        : adminApi.updateCriterion(target.id, value));
      feedback.saved();
    } catch (error) {
      feedback.error(error);
    }

    await reload();
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
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.criteria.order')}</th>
                  <th scope="col">{t('admin.criteria.name')}</th>
                  <th scope="col">{t('admin.criteria.weight')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.actions.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {criteria.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sortOrder}</td>
                    <td>{c.name}</td>
                    <td>{c.weight}</td>
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
          onSave={(v) => void save(v)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
