import { useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { useI18n } from '../../i18n/context';
import type { EvaluationCriterion, SaveEvaluationCriterionRequest } from './models';

/** Create or edit an evaluation criterion: name, weight, order (PDF §8). */
export function CriterionDialog({
  criterion,
  onSave,
  onClose,
}: {
  criterion: EvaluationCriterion | null;
  onSave: (value: SaveEvaluationCriterionRequest) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(criterion?.name ?? '');
  const [weight, setWeight] = useState(String(criterion?.weight ?? 1));
  const [sortOrder, setSortOrder] = useState(String(criterion?.sortOrder ?? 1));
  const [touched, setTouched] = useState(false);

  const errors = {
    name: name.trim() ? null : 'admin.validation.required',
    weight: Number(weight) > 0 ? null : 'admin.validation.positive',
    sortOrder: /^-?\d+$/.test(sortOrder.trim()) ? null : 'admin.validation.integer',
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (errors.name || errors.weight || errors.sortOrder) return;
    onSave({ name: name.trim(), weight: Number(weight), sortOrder: Number(sortOrder) });
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
          'name',
          t('admin.criteria.name'),
          <input
            id="criterion-name"
            className="ims-input"
            value={name}
            maxLength={200}
            autoFocus
            {...invalid('name')}
            onChange={(e) => setName(e.target.value)}
          />,
        )}
        {field(
          'weight',
          t('admin.criteria.weight'),
          <input
            id="criterion-weight"
            className="ims-input"
            type="number"
            min="0"
            step="any"
            dir="ltr"
            value={weight}
            {...invalid('weight')}
            onChange={(e) => setWeight(e.target.value)}
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
