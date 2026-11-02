import { useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { useI18n } from '../../i18n/context';
import type { CreateFieldRequest, Field } from './models';

/** Create or edit a field's name and description. */
export function FieldDialog({
  field,
  onSave,
  onClose,
}: {
  field: Field | null;
  onSave: (value: CreateFieldRequest) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(field?.name ?? '');
  const [description, setDescription] = useState(field?.description ?? '');
  const [touched, setTouched] = useState(false);
  const nameMissing = name.trim().length === 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (nameMissing) return;
    onSave({ name: name.trim(), description: description.trim() || null });
  };

  return (
    <Dialog open title={t(field ? 'admin.fields.edit' : 'admin.fields.add')} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="field-name" className="ims-label">
            {t('admin.fields.name')} *
          </label>
          <input
            id="field-name"
            className="ims-input"
            value={name}
            maxLength={100}
            required
            autoFocus
            aria-invalid={touched && nameMissing}
            aria-describedby={touched && nameMissing ? 'field-name-error' : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {touched && nameMissing && (
            <p id="field-name-error" className="ims-error">
              {t('admin.validation.required')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="field-description" className="ims-label">
            {t('admin.fields.description')}
          </label>
          <textarea
            id="field-description"
            className="ims-input h-auto min-h-24 py-2.5"
            rows={3}
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="ims-btn-text" onClick={onClose}>
            {t('admin.actions.cancel')}
          </button>
          <button type="submit" className="ims-btn-primary">
            {t('admin.actions.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
