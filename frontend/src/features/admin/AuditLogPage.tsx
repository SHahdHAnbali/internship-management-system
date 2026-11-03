import { useEffect, useId, useState } from 'react';
import { useI18n } from '../../i18n/context';
import { PageHeader } from './AdminLayout';
import { adminApi } from './adminApi';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_OPERATIONS,
  AUDITED_TABLES,
  type AuditEntry,
  type AuditFilters,
} from './models';

/**
 * Who acted: the account's name first, then what kind of actor it is (for staff, their current role, which may differ
 * from their role when they acted), then the recorded id in small print (for the actor filter).
 */
function ActorCell({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n();
  const account = entry.actorType === 'Staff' || entry.actorType === 'Trainee';
  const name = !account
    ? t(`admin.auditLog.actorTypes.${entry.actorType}`)
    : !entry.actorKnown
      ? t('admin.auditLog.unknownUser')
      : (entry.actorName ?? t('admin.auditLog.traineeWithoutName'));
  return (
    <>
      <span className="block font-semibold text-heading">{name}</span>
      {account && (
        <span className="block text-small text-muted">
          {entry.actorType === 'Staff' && entry.actorCurrentRole
            ? t('admin.auditLog.staffCurrentRole', { role: t(`roles.${entry.actorCurrentRole}`) })
            : t(`admin.auditLog.actorTypes.${entry.actorType}`)}
        </span>
      )}
      {entry.actorId && (
        <span dir="ltr" className="block break-all text-small text-muted">
          {entry.actorId}
        </span>
      )}
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The start of a calendar day (`YYYY-MM-DD`) on this device, plus `days`, as an instant. */
function localDay(value: string, days = 0): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day + days).toISOString();
}

interface Inputs {
  operation: string;
  table: string;
  actorType: string;
  actorId: string;
  fromDate: string;
  toDate: string;
}

const NO_INPUTS: Inputs = {
  operation: '',
  table: '',
  actorType: '',
  actorId: '',
  fromDate: '',
  toDate: '',
};

/**
 * Admin: the audit log (PDF §5 «سجل التغييرات»; owner decision AD-51: Admin only, read-only, sensitive data hidden).
 * Every recorded change, newest first, with who made it, when, on which table and record; never the stored values.
 * Filters: operation, table, actor (type and id) and a date range (whole days on this device). Load More adds older
 * entries.
 */
export function AuditLogPage() {
  const { t, language } = useI18n();
  const id = useId();
  const [inputs, setInputs] = useState<Inputs>(NO_INPUTS);
  const [log, setLog] = useState<{ key: string; entries: AuditEntry[]; hasMore: boolean }>();
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  const actorIdValid = !inputs.actorId.trim() || UUID.test(inputs.actorId.trim());
  const rangeInvalid = Boolean(inputs.fromDate && inputs.toDate && inputs.toDate < inputs.fromDate);
  // Only valid values are applied; an invalid one is flagged next to its input.
  const filters: AuditFilters = {
    operation: inputs.operation,
    table: inputs.table,
    actorType: inputs.actorType,
    actorId: actorIdValid ? inputs.actorId.trim().toLowerCase() : '',
    from: inputs.fromDate ? localDay(inputs.fromDate) : '',
    to: inputs.toDate && !rangeInvalid ? localDay(inputs.toDate, 1) : '', // the whole last day
  };
  const key = JSON.stringify(filters);

  useEffect(() => {
    let current = true;
    adminApi.auditLogs(JSON.parse(key) as AuditFilters).then(
      (page) => {
        if (!current) return;
        setLog({ key, entries: page.entries, hasMore: page.hasMore });
        setFailedKey(null);
        setMoreFailed(false);
      },
      () => current && setFailedKey(key),
    );
    return () => {
      current = false;
    };
  }, [key]);

  const loadMore = async () => {
    const last = log?.entries.at(-1);
    if (!log || !last) return;
    setLoadingMore(true);
    try {
      const page = await adminApi.auditLogs(filters, last.id);
      setLog((shown) => {
        if (!shown || shown.key !== key) return shown;
        const seen = new Set(shown.entries.map((e) => e.id));
        return {
          key,
          hasMore: page.hasMore,
          entries: [...shown.entries, ...page.entries.filter((e) => !seen.has(e.id))],
        };
      });
      setMoreFailed(false);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (name: keyof Inputs, value: string) =>
    setInputs((now) => ({ ...now, [name]: value }));
  const shown = log?.key === key ? log : undefined;

  const select = (
    name: 'operation' | 'table' | 'actorType',
    label: string,
    options: readonly string[],
    optionLabel: (value: string) => string,
  ) => (
    <div className="flex flex-col gap-1">
      <label className="ims-label" htmlFor={`${id}-${name}`}>
        {t(label)}
      </label>
      <select
        id={`${id}-${name}`}
        className="ims-input"
        value={inputs[name]}
        onChange={(e) => set(name, e.target.value)}
      >
        <option value="">{t('admin.auditLog.any')}</option>
        {options.map((value) => (
          <option key={value} value={value}>
            {optionLabel(value)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <PageHeader title={t('admin.auditLog.title')} />
      <p className="-mt-4 mb-8 text-muted">{t('admin.auditLog.description')}</p>

      <form
        role="search"
        aria-label={t('admin.auditLog.filters')}
        className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(event) => event.preventDefault()}
      >
        {select('operation', 'admin.auditLog.operation', AUDIT_OPERATIONS, (v) =>
          t(`admin.auditLog.operations.${v}`),
        )}
        {select('table', 'admin.auditLog.table', AUDITED_TABLES, (v) =>
          t(`admin.auditLog.tables.${v}`),
        )}
        {select('actorType', 'admin.auditLog.actorType', AUDIT_ACTOR_TYPES, (v) =>
          t(`admin.auditLog.actorTypes.${v}`),
        )}
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-actor`}>
            {t('admin.auditLog.actorId')}
          </label>
          <input
            id={`${id}-actor`}
            className="ims-input"
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            value={inputs.actorId}
            aria-invalid={!actorIdValid}
            aria-describedby={actorIdValid ? undefined : `${id}-actor-error`}
            onChange={(e) => set('actorId', e.target.value)}
          />
          {!actorIdValid && (
            <p id={`${id}-actor-error`} className="ims-error">
              {t('admin.auditLog.actorIdInvalid')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-from`}>
            {t('admin.auditLog.from')}
          </label>
          <input
            id={`${id}-from`}
            type="date"
            className="ims-input"
            value={inputs.fromDate}
            onChange={(e) => set('fromDate', e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="ims-label" htmlFor={`${id}-to`}>
            {t('admin.auditLog.to')}
          </label>
          <input
            id={`${id}-to`}
            type="date"
            className="ims-input"
            value={inputs.toDate}
            min={inputs.fromDate || undefined}
            aria-invalid={rangeInvalid}
            aria-describedby={rangeInvalid ? `${id}-to-error` : undefined}
            onChange={(e) => set('toDate', e.target.value)}
          />
          {rangeInvalid && (
            <p id={`${id}-to-error`} className="ims-error">
              {t('admin.auditLog.rangeInvalid')}
            </p>
          )}
        </div>
      </form>

      {failedKey === key ? (
        <p className="ims-state" role="alert">
          {t('admin.auditLog.loadFailed')}
        </p>
      ) : !shown ? (
        <p className="ims-state" role="status">
          {t('common.loading')}
        </p>
      ) : shown.entries.length === 0 ? (
        <p className="ims-state">{t('admin.auditLog.empty')}</p>
      ) : (
        <>
          <div className="ims-table-card">
            <table className="ims-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.auditLog.number')}</th>
                  <th scope="col">{t('admin.auditLog.time')}</th>
                  <th scope="col">{t('admin.auditLog.actor')}</th>
                  <th scope="col">{t('admin.auditLog.operation')}</th>
                  <th scope="col">{t('admin.auditLog.table')}</th>
                  <th scope="col">{t('admin.auditLog.record')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td dir="ltr" className="text-start">
                      {entry.id}
                    </td>
                    <td>{new Date(entry.occurredAt).toLocaleString(language)}</td>
                    <td>
                      <ActorCell entry={entry} />
                    </td>
                    <td>
                      <span className="ims-badge">
                        {t(`admin.auditLog.operations.${entry.operation}`)}
                      </span>
                    </td>
                    <td>{t(`admin.auditLog.tables.${entry.table}`)}</td>
                    <td>
                      {entry.entityId ? (
                        <span dir="ltr" className="break-all text-small">
                          {entry.entityId}
                        </span>
                      ) : (
                        <span className="text-muted">{t('admin.auditLog.recordHidden')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {moreFailed && (
            <p role="alert" className="ims-error mt-4">
              {t('admin.auditLog.loadFailed')}
            </p>
          )}
          {shown.hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                className="ims-btn-outline"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {t('admin.auditLog.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
