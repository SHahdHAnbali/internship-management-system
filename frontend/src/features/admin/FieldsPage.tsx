import { useState } from 'react';
import { Switch } from '../../components/Switch';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import { useAdminFeedback } from './feedback';
import { FieldDialog } from './FieldDialog';
import type { CreateFieldRequest, Field } from './models';
import { useLoad } from './useLoad';

/** Admin: manage training fields — add, edit, activate/deactivate (PDF §4, §8). */
export function FieldsPage() {
  const { t } = useI18n();
  const feedback = useAdminFeedback();
  const {
    data: fields,
    loading,
    failed,
    reload,
  } = useLoad('fields', adminApi.listFields, feedback.error);
  const [editing, setEditing] = useState<Field | null | 'new'>(null);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      feedback.saved();
    } catch (error) {
      feedback.error(error);
    }

    await reload();
  };

  const save = (value: CreateFieldRequest) => {
    const target = editing;
    setEditing(null);
    void run(() =>
      target === 'new' || target === null
        ? adminApi.createField(value)
        : adminApi.updateField(target.id, { ...value, isActive: target.isActive }),
    );
  };

  return (
    <>
      <PageHeader title={t('admin.fields.title')}>
        <button type="button" className="ims-btn-primary" onClick={() => setEditing('new')}>
          {t('admin.fields.add')}
        </button>
      </PageHeader>

      {failed ? (
        <p className="ims-state">{t('admin.errors.loadFailed')}</p>
      ) : !loading && fields?.length === 0 ? (
        <p className="ims-state">{t('admin.fields.empty')}</p>
      ) : (
        fields && (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.fields.name')}</th>
                  <th scope="col">{t('admin.fields.description')}</th>
                  <th scope="col">{t('admin.fields.active')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.actions.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => (
                  <tr key={field.id}>
                    <td>{field.name}</td>
                    <td className="text-muted!">{field.description}</td>
                    <td>
                      <Switch
                        checked={field.isActive}
                        label={`${t('admin.fields.active')}: ${field.name}`}
                        onChange={(isActive) =>
                          void run(() =>
                            adminApi.updateField(field.id, {
                              name: field.name,
                              description: field.description,
                              isActive,
                            }),
                          )
                        }
                      />
                    </td>
                    <td className="text-end">
                      <button
                        type="button"
                        className="ims-btn-text"
                        onClick={() => setEditing(field)}
                      >
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
        <FieldDialog
          field={editing === 'new' ? null : editing}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
