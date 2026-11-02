import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import { openFileLink } from '../../lib/fileLinks';
import { employeeApi } from './employeeApi';
import type { AvailableFilters, AvailableTrainee, FieldOption } from './models';

const NO_FILTERS: AvailableFilters = { fieldId: '', university: '', from: '', to: '' };

/**
 * Available trainees (PDF §4): accepted by HR and not yet assigned, filterable by field, university and period, with
 * their CV. "I want to train them" sends a request with a short note; it then waits for HR's approval.
 */
export function AvailableTraineesPage() {
  const { t, language } = useI18n();
  const toast = useToast();
  const id = useId();
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [filters, setFilters] = useState<AvailableFilters>(NO_FILTERS);
  const [trainees, setTrainees] = useState<AvailableTrainee[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [requesting, setRequesting] = useState<AvailableTrainee | null>(null);

  const load = useCallback(
    (values: AvailableFilters) =>
      employeeApi.available(values).then(
        (list) => {
          setTrainees(list);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  useEffect(() => {
    void load(NO_FILTERS);
    employeeApi.fields().then(setFields, () => undefined);
  }, [load]);

  const date = (value: string) => new Date(value).toLocaleDateString(language);
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    void load(filters);
  };

  return (
    <>
      <h1 className="ims-page-title mb-2">{t('employee.available.title')}</h1>
      <p className="mb-6 max-w-3xl text-muted">{t('employee.available.intro')}</p>

      <form
        onSubmit={applyFilters}
        aria-label={t('employee.available.filters')}
        className="ims-card mb-6 grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-field`}>
            {t('training.fields.field')}
          </label>
          <select
            id={`${id}-field`}
            className="ims-input"
            value={filters.fieldId}
            onChange={(e) => setFilters({ ...filters, fieldId: e.target.value })}
          >
            <option value="">{t('employee.available.allFields')}</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-university`}>
            {t('training.profile.university')}
          </label>
          <input
            id={`${id}-university`}
            className="ims-input"
            value={filters.university}
            onChange={(e) => setFilters({ ...filters, university: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-from`}>
            {t('employee.available.from')}
          </label>
          <input
            id={`${id}-from`}
            type="date"
            className="ims-input"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-to`}>
            {t('employee.available.to')}
          </label>
          <input
            id={`${id}-to`}
            type="date"
            className="ims-input"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </div>
        <div className="flex gap-2">
          <button type="submit" className="ims-btn-primary">
            {t('employee.available.search')}
          </button>
          <button
            type="button"
            className="ims-btn-text"
            onClick={() => {
              setFilters(NO_FILTERS);
              void load(NO_FILTERS);
            }}
          >
            {t('employee.available.clear')}
          </button>
        </div>
      </form>

      {failed ? (
        <p className="ims-state">{t('training.errors.loadFailed')}</p>
      ) : trainees?.length === 0 ? (
        <p className="ims-state">{t('employee.available.empty')}</p>
      ) : (
        trainees && (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('training.profile.fullName')}</th>
                  <th scope="col">{t('training.fields.field')}</th>
                  <th scope="col">{t('training.profile.university')}</th>
                  <th scope="col">{t('training.fields.period')}</th>
                  <th scope="col">{t('training.fields.hours')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('employee.available.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {trainees.map((trainee) => (
                  <tr key={trainee.applicationId}>
                    <td>
                      <span className="font-semibold text-heading">{trainee.trainee.fullName}</span>
                      <span className="block text-small text-muted">
                        {trainee.trainee.major} · {trainee.trainee.studyYear}
                      </span>
                    </td>
                    <td>{trainee.field.name}</td>
                    <td>{trainee.trainee.university}</td>
                    <td>
                      {date(trainee.availableFrom)} – {date(trainee.availableTo)}
                    </td>
                    <td>{trainee.hours}</td>
                    <td className="text-end">
                      <div className="flex flex-wrap justify-end gap-1">
                        {trainee.hasCv && (
                          <button
                            type="button"
                            className="ims-btn-text"
                            aria-label={`${t('employee.available.viewCv')}: ${trainee.trainee.fullName ?? ''}`}
                            onClick={() =>
                              openFileLink(() => employeeApi.cvLink(trainee.applicationId)).catch(
                                () => toast('training.errors.fileUnavailable'),
                              )
                            }
                          >
                            {t('employee.available.viewCv')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="ims-btn-outline"
                          onClick={() => setRequesting(trainee)}
                        >
                          {t('employee.available.wantToTrain')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {requesting && (
        <RequestDialog
          trainee={requesting}
          onClose={() => setRequesting(null)}
          onSent={() => {
            setRequesting(null);
            toast('employee.request.sent');
            void load(filters);
          }}
        />
      )}
    </>
  );
}

function RequestDialog({
  trainee,
  onClose,
  onSent,
}: {
  trainee: AvailableTrainee;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (note.trim() === '') {
      setError('employee.request.noteRequired');
      return;
    }

    setSending(true);
    try {
      await employeeApi.requestToTrain(trainee.applicationId, note.trim());
      onSent();
    } catch (failure) {
      setError(
        failure instanceof ApiError &&
          (failure.code === 'mentor_request.not_available' || failure.status === 409)
          ? 'employee.request.notAvailable'
          : 'training.errors.generic',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open
      title={t('employee.request.title', { name: trainee.trainee.fullName ?? '' })}
      onClose={onClose}
    >
      <form onSubmit={(e) => void send(e)} className="flex flex-col gap-4">
        <p className="text-muted">{t('employee.request.explain')}</p>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-note`}>
            {t('employee.request.note')}
          </label>
          <textarea
            id={`${id}-note`}
            className="ims-input min-h-28"
            value={note}
            maxLength={2000}
            aria-invalid={error === 'employee.request.noteRequired' || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="ims-error">
              {t(error)}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="ims-btn-text" onClick={onClose}>
            {t('training.cancel')}
          </button>
          <button type="submit" className="ims-btn-primary" disabled={sending}>
            {t('employee.request.send')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
