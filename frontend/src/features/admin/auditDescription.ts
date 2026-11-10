import type { Params } from '../../i18n/translate';
import type { AuditEntry } from './models';

type Translate = (key: string, params?: Params) => string;

/**
 * Where each description parameter's value is translated: roles and statuses use the names the rest of the app uses.
 * `changes` is a list of property codes, translated under `admin.auditLog.properties`.
 */
const PARAM_PREFIX: Record<string, string> = {
  status: 'training.applicationStatus',
  role: 'roles',
  fromRole: 'roles',
  toRole: 'roles',
  fromAssignmentStatus: 'training.assignmentStatus',
  toAssignmentStatus: 'training.assignmentStatus',
};

/** The translation, or null when there is none (`translate` returns the key itself for an unknown one). */
function known(t: Translate, key: string, params?: Params): string | null {
  const text = t(key, params);
  return text && text !== key && text.trim() ? text : null;
}

/** The parameters in the reader's language, or null if any of them cannot be translated. */
function translatedParams(
  t: Translate,
  params: Record<string, string | string[]> | undefined,
): Params | null {
  const result: Params = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (name === 'changes' && Array.isArray(value) && value.length > 0) {
      const names = value.map((code) => known(t, `admin.auditLog.properties.${code}`));
      if (names.some((n) => n === null)) return null;
      result[name] = names.join(t('admin.auditLog.listSeparator'));
    } else if (typeof value === 'string' && PARAM_PREFIX[name]) {
      const translated = known(t, `${PARAM_PREFIX[name]}.${value}`);
      if (translated === null) return null;
      result[name] = translated;
    } else {
      return null;
    }
  }
  return result;
}

/**
 * The sentence describing an audit entry (owner requirements ADL-01 to ADL-06), never empty and never a raw key:
 * 1. the API's event, when it and every parameter can be translated;
 * 2. otherwise what the table and operation alone say ("A training field was updated");
 * 3. for a table this version does not know, "a record was created / changed in another part of the system";
 * 4. for anything else, "a change to the system's data was recorded".
 */
export function describeEntry(t: Translate, entry: AuditEntry): string {
  const description = entry.description;
  if (description && typeof description.event === 'string') {
    const key = `admin.auditLog.events.${description.event}`;
    const template = known(t, key);
    const params = translatedParams(t, description.params);
    const needed = [...(template ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!);
    if (template && params && needed.every((name) => name in params)) {
      const text = known(t, key, params);
      if (text) return text;
    }
  }
  const action =
    entry.operation === 'INSERT' ? 'created' : entry.operation === 'UPDATE' ? 'updated' : null;
  return (
    (action &&
      (known(t, `admin.auditLog.events.${entry.table}.${action}`) ??
        known(t, `admin.auditLog.events.other.${action}`))) ||
    t('admin.auditLog.events.unknown')
  );
}

/** A table or operation label, or a general one when this version has no name for it. */
export function labelOf(t: Translate, group: 'tables' | 'operations', value: string): string {
  return known(t, `admin.auditLog.${group}.${value}`) ?? t(`admin.auditLog.${group}.other`);
}
