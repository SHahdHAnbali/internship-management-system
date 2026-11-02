import { Fragment, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useToast } from '../../components/toastContext';
import { useI18n } from '../../i18n/context';
import { ApiError } from '../../lib/api';
import type { FieldOption, Profile } from './models';
import { traineeApi } from './traineeApi';

const PROFILE = ['fullName', 'phone', 'university', 'major', 'studyYear'] as const;

/** Maps the API's answer to the message shown above the form. */
function errorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return 'training.errors.generic';
  if (error.status === 429) return 'training.errors.tooManyRequests';
  switch (error.code) {
    case 'application.cv_required':
      return 'trainee.apply.errors.cvRequired';
    case 'application.invalid_period':
      return 'trainee.apply.errors.period';
    case 'application.field_unavailable':
      return 'trainee.apply.errors.fieldUnavailable';
    case 'validation.range':
      return 'trainee.apply.errors.hours';
    default:
      return error.status === 400 ? 'trainee.apply.errors.invalid' : 'training.errors.generic';
  }
}

/**
 * The application form (PDF §4): name, phone, university, major, study year, requested field, available period,
 * number of hours, whether the training is mandatory for the university, the CV and any university letter.
 */
export function ApplyPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const id = useId();
  const [fields, setFields] = useState<FieldOption[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const cvInput = useRef<HTMLInputElement>(null);
  const lettersInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([traineeApi.fields(), traineeApi.profile()]).then(
      ([f, p]) => {
        setFields(f);
        setProfile(p);
      },
      () => setFailed(true),
    );
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cv = [...(cvInput.current?.files ?? [])];
    if (cv.length === 0) {
      setError('trainee.apply.errors.cvRequired');
      return;
    }

    // The text fields from the form; the files explicitly from their inputs.
    const form = new FormData(event.currentTarget);
    form.delete('cv');
    form.delete('letters');
    cv.forEach((file) => form.append('cv', file));
    [...(lettersInput.current?.files ?? [])].forEach((file) => form.append('letters', file));

    setError(null);
    setSending(true);
    try {
      await traineeApi.submit(form);
      toast('trainee.apply.sent');
      navigate('/trainee');
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setSending(false);
    }
  };

  const input = (name: string, label: string, props: Record<string, unknown> = {}) => (
    <div className="flex flex-col gap-1">
      <label className="ims-label" htmlFor={`${id}-${name}`}>
        {t(label)}
      </label>
      <input id={`${id}-${name}`} name={name} className="ims-input" required {...props} />
    </div>
  );

  if (failed) return <p className="ims-state">{t('training.errors.loadFailed')}</p>;
  if (!fields || !profile) return null;

  return (
    <>
      <h1 className="ims-page-title mb-2">{t('trainee.apply.title')}</h1>
      <p className="mb-8 max-w-3xl text-muted">{t('trainee.apply.intro')}</p>

      {fields.length === 0 ? (
        <p className="ims-state">{t('trainee.apply.noFields')}</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="ims-card flex max-w-3xl flex-col gap-6">
          {error && (
            <p id={`${id}-error`} role="alert" className="ims-error">
              {t(error)}
            </p>
          )}

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-semibold text-heading">
              {t('trainee.apply.aboutYou')}
            </legend>
            {profile.fullName === null ? (
              // First application: it records the profile (PDF §8).
              PROFILE.map((name) => (
                <Fragment key={name}>
                  {input(name, `training.profile.${name}`, {
                    defaultValue: profile[name] ?? '',
                    autoComplete: name === 'fullName' ? 'name' : name === 'phone' ? 'tel' : 'off',
                    type: name === 'phone' ? 'tel' : 'text',
                  })}
                </Fragment>
              ))
            ) : (
              // Recorded by an earlier application and not changed by this one (changing it is not defined yet).
              <>
                <p className="text-small text-muted sm:col-span-2">
                  {t('trainee.apply.profileRecorded')}
                </p>
                <dl className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
                  {PROFILE.map((name) => (
                    <div key={name}>
                      <dt className="text-small text-muted">{t(`training.profile.${name}`)}</dt>
                      <dd className="text-heading">{profile[name]}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-semibold text-heading">
              {t('trainee.apply.training')}
            </legend>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className="ims-label" htmlFor={`${id}-fieldId`}>
                {t('training.fields.field')}
              </label>
              <select
                id={`${id}-fieldId`}
                name="fieldId"
                className="ims-input"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  {t('trainee.apply.chooseField')}
                </option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            {input('availableFrom', 'training.fields.availableFrom', { type: 'date' })}
            {input('availableTo', 'training.fields.availableTo', { type: 'date' })}
            {input('hours', 'training.fields.hours', {
              type: 'number',
              min: 1,
              step: 1,
              inputMode: 'numeric',
            })}
            <fieldset className="flex flex-col gap-1">
              <legend className="ims-label">{t('training.fields.mandatoryForUniversity')}</legend>
              <div className="flex gap-6 pt-2">
                {(['true', 'false'] as const).map((value) => (
                  <label key={value} className="flex items-center gap-2">
                    <input type="radio" name="mandatoryForUniversity" value={value} required />
                    {t(value === 'true' ? 'training.yes' : 'training.no')}
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 font-semibold text-heading">
              {t('trainee.apply.documents')}
            </legend>
            <div className="flex flex-col gap-1">
              <label className="ims-label" htmlFor={`${id}-cv`}>
                {t('training.attachmentKind.Cv')}
              </label>
              <input
                ref={cvInput}
                id={`${id}-cv`}
                name="cv"
                type="file"
                className="ims-input"
                aria-invalid={error === 'trainee.apply.errors.cvRequired' || undefined}
                aria-describedby={error ? `${id}-error` : undefined}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="ims-label" htmlFor={`${id}-letters`}>
                {t('trainee.apply.letters')}
              </label>
              <input
                ref={lettersInput}
                id={`${id}-letters`}
                name="letters"
                type="file"
                multiple
                className="ims-input"
              />
            </div>
          </fieldset>

          <div className="flex justify-end">
            <button type="submit" className="ims-btn-primary" disabled={sending}>
              {t('trainee.apply.submit')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
