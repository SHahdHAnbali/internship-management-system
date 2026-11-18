import { useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { useI18n } from '../../i18n/context';
import type { CreateEvaluationCriterionRequest, EvaluationCriterion } from './models';

/** Create or edit an evaluation criterion (AD-66): Arabic and English names and order; no weights. */
export function CriterionDialog({
  criterion,
  onSave,
  onClose,
}: {
  criterion: EvaluationCriterion | null;
  onSave: (value: CreateEvaluationCriterionRequest) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [nameAr, setNameAr] = useState(criterion?.nameAr ?? '');
  const [nameEn, setNameEn] = useState(criterion?.nameEn ?? '');
  const [sortOrder, setSortOrder] = useState(String(criterion?.sortOrder ?? 1));
  const [touched, setTouched] = useState(false);

  const errors = {
    nameAr: nameAr.trim() ? null : 'admin.validation.required',
    nameEn: nameEn.trim() ? null : 'admin.validation.required',
    sortOrder: /^-?\d+$/.test(sortOrder.trim()) ? null : 'admin.validation.integer',
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (errors.nameAr || errors.nameEn || errors.sortOrder) return;
    onSave({ nameAr: nameAr.trim(), nameEn: nameEn.trim(), sortOrder: Number(sortOrder) });
  };

  const field = (id: keyof typeof errors, label: string, input: React.ReactNode) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`criterion-${id}`} className="ims-label">
        {label} *
      </label>
      {input}
      {touched && errors[id] && (
        <p id={`criterion-${id}-error`} className="ims-error">
          {t(errors[id]!)}
        </p>
      )}
    </div>
  );

  const invalid = (id: keyof typeof errors) => ({
    'aria-invalid': touched && !!errors[id],
    'aria-describedby': touched && errors[id] ? `criterion-${id}-error` : undefined,
  });

  return (
    <Dialog
      open
      title={t(criterion ? 'admin.criteria.edit' : 'admin.criteria.add')}
      onClose={onClose}
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {field(
          'nameAr',
          t('admin.criteria.nameAr'),
          <input
            id="criterion-nameAr"
            className="ims-input"
            lang="ar"
            dir="rtl"
            value={nameAr}
            maxLength={200}
            autoFocus
            {...invalid('nameAr')}
            onChange={(e) => setNameAr(e.target.value)}
          />,
        )}
        {field(
          'nameEn',
          t('admin.criteria.nameEn'),
          <input
            id="criterion-nameEn"
            className="ims-input"
            lang="en"
            dir="ltr"
            value={nameEn}
            maxLength={200}
            {...invalid('nameEn')}
            onChange={(e) => setNameEn(e.target.value)}
          />,
        )}
        {field(
          'sortOrder',
          t('admin.criteria.order'),
          <input
            id="criterion-sortOrder"
            className="ims-input"
            type="number"
            step="1"
            dir="ltr"
            value={sortOrder}
            {...invalid('sortOrder')}
            onChange={(e) => setSortOrder(e.target.value)}
          />,
        )}
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
