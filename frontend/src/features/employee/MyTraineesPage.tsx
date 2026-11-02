import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useToast } from '../../components/toastContext';
import { openFileLink } from '../../lib/fileLinks';
import { useI18n } from '../../i18n/context';
import { employeeApi } from './employeeApi';
import type { MyMentorRequest, MyTrainee, ProgressNote } from './models';

/**
 * My trainees (PDF §4): the signed-in employee's own requests (waiting for HR or decided), current trainees (active
 * assignments) with their periodic notes, and previous trainees.
 */
export function MyTraineesPage() {
  const { t, language } = useI18n();
  const [requests, setRequests] = useState<MyMentorRequest[] | null>(null);
  const [trainees, setTrainees] = useState<MyTrainee[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    Promise.all([employeeApi.myRequests(), employeeApi.myTrainees()]).then(
      ([r, a]) => {
        setRequests(r);
        setTrainees(a);
      },
      () => setFailed(true),
    );
  }, []);

  const date = (value: string) => new Date(value).toLocaleDateString(language);
  if (failed) return <p className="ims-state">{t('training.errors.loadFailed')}</p>;
  if (!requests || !trainees) return null;

  const current = trainees.filter((a) => a.status === 'Active');
  const previous = trainees.filter((a) => a.status !== 'Active');

  return (
    <>
      <h1 className="ims-page-title mb-8">{t('employee.trainees.title')}</h1>

      <section aria-labelledby="current-title" className="mb-10">
        <h2 id="current-title" className="mb-4 text-h3 font-semibold text-heading">
          {t('employee.trainees.current')}
        </h2>
        {current.length === 0 ? (
          <p className="ims-state">{t('employee.trainees.noCurrent')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {current.map((a) => (
              <li key={a.id} className="ims-card flex flex-col gap-4">
                <TraineeSummary assignment={a} date={date} />
                <Notes assignmentId={a.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="requests-title" className="mb-10">
        <h2 id="requests-title" className="mb-4 text-h3 font-semibold text-heading">
          {t('employee.trainees.requests')}
        </h2>
        {requests.length === 0 ? (
          <p className="ims-state">{t('employee.trainees.noRequests')}</p>
        ) : (
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('training.profile.fullName')}</th>
                  <th scope="col">{t('training.fields.field')}</th>
                  <th scope="col">{t('employee.request.note')}</th>
                  <th scope="col">{t('employee.trainees.requestedAt')}</th>
                  <th scope="col">{t('employee.trainees.status')}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.traineeName}
                      {r.status === 'Pending' && (
                        <CvButton applicationId={r.applicationId} name={r.traineeName} />
                      )}
                    </td>
                    <td>{r.fieldName}</td>
                    <td className="text-muted!">{r.note}</td>
                    <td>{date(r.requestedAt)}</td>
                    <td>
                      <span className="ims-badge">{t(`training.requestStatus.${r.status}`)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="previous-title">
        <h2 id="previous-title" className="mb-4 text-h3 font-semibold text-heading">
          {t('employee.trainees.previous')}
        </h2>
        {previous.length === 0 ? (
          <p className="ims-state">{t('employee.trainees.noPrevious')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {previous.map((a) => (
              <li key={a.id} className="ims-card">
                <TraineeSummary assignment={a} date={date} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function TraineeSummary({
  assignment: a,
  date,
}: {
  assignment: MyTrainee;
  date: (value: string) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="font-semibold text-heading">{a.trainee.fullName}</h3>
        <p className="text-small text-muted">
          {a.fieldName} · {a.trainee.university} · {date(a.startDate)} – {date(a.endDate)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <CvButton applicationId={a.applicationId} name={a.trainee.fullName} />
        <span className="ims-badge">{t(`training.assignmentStatus.${a.status}`)}</span>
      </div>
    </div>
  );
}

/** Periodic notes on a current training: written by its mentor, never edited. */
function Notes({ assignmentId }: { assignmentId: string }) {
  const { t, language } = useI18n();
  const toast = useToast();
  const id = useId();
  const [notes, setNotes] = useState<ProgressNote[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      employeeApi.notes(assignmentId).then(
        (loaded) => {
          setNotes(loaded);
          setLoadFailed(false);
        },
        () => setLoadFailed(true), // a failure is not an empty list
      ),
    [assignmentId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === '') {
      setError(true);
      return;
    }

    setSaving(true);
    try {
      await employeeApi.addNote(assignmentId, text.trim());
      setText('');
      setError(false);
      toast('employee.notes.saved');
      await load();
    } catch {
      toast('training.errors.generic');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-divider pt-4">
      <h4 className="mb-2 font-semibold text-heading">{t('employee.notes.title')}</h4>
      <form onSubmit={(e) => void add(e)} className="mb-4 flex flex-col gap-2">
        <label className="ims-label" htmlFor={`${id}-note`}>
          {t('employee.notes.new')}
        </label>
        <textarea
          id={`${id}-note`}
          className="ims-input min-h-20"
          value={text}
          maxLength={4000}
          aria-invalid={error || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {error && (
          <p id={`${id}-error`} role="alert" className="ims-error">
            {t('employee.notes.required')}
          </p>
        )}
        <div className="flex justify-end">
          <button type="submit" className="ims-btn-outline" disabled={saving}>
            {t('employee.notes.add')}
          </button>
        </div>
      </form>
      {loadFailed ? (
        <p role="alert" className="ims-error">
          {t('employee.notes.loadFailed')}
        </p>
      ) : notes && notes.length === 0 ? (
        <p className="text-small text-muted">{t('employee.notes.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notes?.map((note) => (
            <li key={note.id} className="rounded-control bg-surface-subtle p-3">
              <p className="whitespace-pre-line">{note.text}</p>
              <p className="mt-1 text-small text-muted">
                {note.authorName} · {new Date(note.writtenAt).toLocaleString(language)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The CV of the employee's own requested or assigned trainee, through a temporary link. */
function CvButton({ applicationId, name }: { applicationId: string; name: string | null }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <button
      type="button"
      className="ims-btn-text"
      aria-label={`${t('employee.available.viewCv')}: ${name ?? ''}`}
      onClick={() =>
        openFileLink(() => employeeApi.cvLink(applicationId)).catch(() =>
          toast('training.errors.fileUnavailable'),
        )
      }
    >
      {t('employee.available.viewCv')}
    </button>
  );
}
