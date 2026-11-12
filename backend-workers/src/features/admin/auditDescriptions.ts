/**
 * Descriptions of audit log entries (owner requirements ADL-01 to ADL-06, 2026-11-10): every entry, old or new, gets an
 * event code that the web app turns into an Arabic or English sentence. Nothing is stored or rewritten: the code is
 * derived when the log is read, from a few allowlisted facts of the stored row (`AUDIT_FACTS_SQL`), so history written
 * before this existed is described too.
 *
 * Only facts that cannot identify or expose anyone are read: status, role, read and active flags, file kind,
 * notification type, revoke reason, which kind of account a session belongs to, and the names of the columns an update
 * changed. Names, e-mails, notes, reasons, file names, hashes and ids never leave the database. Each value is checked
 * against its allowlist here; anything unexpected falls back to a more general event, and an unknown table or operation
 * to a universal one, so no entry is ever without a description and none says more than the record shows.
 *
 * This module has no imports, so a read-only coverage check can use it outside the Worker.
 */

/** Every table with the audit trigger (`ims_protect_table`). */
export const AUDITED_TABLES = [
  'application_attachments',
  'assignment_extensions',
  'assignments',
  'certificate_templates',
  'contact_logs',
  'employees',
  'evaluation_criteria',
  'fields',
  'mentor_requests',
  'notification_settings',
  'notifications',
  'progress_notes',
  'roles',
  'trainee_sign_in_codes',
  'trainees',
  'training_applications',
  'user_sessions',
] as const;
export type AuditedTable = (typeof AUDITED_TABLES)[number];

const APPLICATION_STATUSES = ['Submitted', 'UnderReview', 'Accepted', 'Rejected'] as const;
const REQUEST_STATUSES = ['Pending', 'Approved', 'Rejected'] as const;
const ASSIGNMENT_STATUSES = ['Active', 'Completed', 'EndedEarly', 'Transferred', 'Withdrawn'] as const;
const STAFF_ROLES = ['Employee', 'HR', 'Admin'] as const;
const NOTIFICATION_TYPES = [
  'ApplicationSubmitted',
  'MentorRequestSubmitted',
  'MentorRequestApproved',
  'MentorRequestRejected',
] as const;
const IMAGE_ACTIONS = { uploaded: 'Uploaded', replaced: 'Replaced', removed: 'Removed' } as const;

/** The properties an update may name, per table (column → property code shown in the description). */
const CRITERION_PROPERTIES: Record<string, string> = {
  name: 'criterion.name',
  weight: 'criterion.weight',
  sort_order: 'criterion.order',
};
const INTERVAL_PROPERTIES: Record<string, string> = {
  training_ending_notice_days: 'intervals.trainingEnding',
  late_evaluation_reminder_days: 'intervals.lateEvaluation',
  pending_request_alert_days: 'intervals.pendingRequest',
};
const PROFILE_COLUMNS = ['full_name', 'phone', 'university', 'major', 'study_year'];

/** Events that say more than "a record was created/changed". */
const SPECIFIC_EVENTS = [
  'application.createdWithStatus',
  'application.underReview',
  'application.accepted',
  'application.rejected',
  'attachment.cv',
  'attachment.universityLetter',
  'trainee.profileRecorded',
  'signInCode.used',
  'signInCode.superseded',
  'signInCode.failedAttempt',
  'session.startedStaff',
  'session.startedTrainee',
  'session.startedGoogle',
  'session.signedOut',
  'session.replaced',
  'employee.createdWithRole',
  'employee.roleChanged',
  'field.createdActive',
  'field.createdInactive',
  'field.activated',
  'field.deactivated',
  'field.updatedActivated',
  'field.updatedDeactivated',
  'criterion.changed',
  'intervals.changed',
  'certificate.settingsChanged',
  ...['logo', 'signature'].flatMap((image) => Object.values(IMAGE_ACTIONS).map((a) => `certificate.${image}${a}`)),
  'mentorRequest.approved',
  'mentorRequest.rejected',
  'assignment.createdFromRequest',
  'assignment.createdDirect',
  'assignment.statusChanged',
  ...NOTIFICATION_TYPES.map((type) => `notification.created${type}`),
  'notification.read',
] as const;

/**
 * Every event code, from the most specific to the universal one. Per table: `<table>.created` and `<table>.updated` (a
 * truthful sentence about that kind of record); `other.created` / `other.updated` for a table not known here; `unknown`
 * when even the operation is not known.
 */
export const AUDIT_EVENTS: readonly string[] = [
  ...SPECIFIC_EVENTS,
  ...AUDITED_TABLES.flatMap((table) => [`${table}.created`, `${table}.updated`]),
  'other.created',
  'other.updated',
  'unknown',
];

/** The parameter each event fills in, and the kind of value it holds (the web app translates each kind). */
export const AUDIT_EVENT_PARAMS: Record<string, readonly string[]> = {
  'application.createdWithStatus': ['status'],
  'employee.createdWithRole': ['role'],
  'employee.roleChanged': ['fromRole', 'toRole'],
  'assignment.statusChanged': ['fromAssignmentStatus', 'toAssignmentStatus'],
  'criterion.changed': ['changes'],
  'intervals.changed': ['changes'],
};

export interface AuditDescription {
  event: string;
  params?: Record<string, string | string[]>;
}

/**
 * The facts read for a description, built in SQL from the stored row `a` (an `audit_logs` row). Each is read only for
 * the table it belongs to, and only as a short code, a flag or a list of column names.
 */
export const AUDIT_FACTS_SQL = `CASE WHEN jsonb_typeof(a.new_values) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
    'changed', CASE WHEN a.operation = 'UPDATE'
                    THEN (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(a.new_values) AS k) END,
    'oldStatus', CASE WHEN a.table_name IN ('training_applications', 'mentor_requests', 'assignments')
                       AND jsonb_typeof(a.old_values) = 'object' THEN a.old_values ->> 'status' END,
    'newStatus', CASE WHEN a.table_name IN ('training_applications', 'mentor_requests', 'assignments')
                      THEN a.new_values ->> 'status' END,
    'oldRole', CASE WHEN a.table_name = 'employees' AND jsonb_typeof(a.old_values) = 'object'
                    THEN a.old_values ->> 'role' END,
    'newRole', CASE WHEN a.table_name = 'employees' THEN a.new_values ->> 'role' END,
    'active', CASE WHEN a.table_name = 'fields' THEN a.new_values ->> 'is_active' END,
    'read', CASE WHEN a.table_name = 'notifications' THEN a.new_values ->> 'is_read' END,
    'notificationType', CASE WHEN a.table_name = 'notifications' THEN a.new_values ->> 'type' END,
    'revokeReason', CASE WHEN a.table_name = 'user_sessions' THEN a.new_values ->> 'revoke_reason' END,
    'sessionOwner', CASE WHEN a.table_name = 'user_sessions' AND a.operation = 'INSERT' THEN
                      CASE WHEN a.new_values ->> 'employee_id' IS NOT NULL THEN 'employee'
                           WHEN a.new_values ->> 'trainee_id' IS NOT NULL THEN 'trainee'
                           WHEN a.new_values ->> 'google_subject' IS NOT NULL THEN 'google' END END,
    'kind', CASE WHEN a.table_name = 'application_attachments' THEN a.new_values ->> 'kind' END,
    'fromRequest', CASE WHEN a.table_name = 'assignments' AND a.operation = 'INSERT'
                        THEN a.new_values ->> 'mentor_request_id' IS NOT NULL END,
    'logoAction', CASE WHEN a.table_name = 'certificate_templates'
                            AND jsonb_typeof(a.new_values -> 'logo_image') = 'object'
                       THEN a.new_values -> 'logo_image' ->> 'action' END,
    'signatureAction', CASE WHEN a.table_name = 'certificate_templates'
                                 AND jsonb_typeof(a.new_values -> 'signature_image') = 'object'
                            THEN a.new_values -> 'signature_image' ->> 'action' END,
    'profileWasEmpty', CASE WHEN a.table_name = 'trainees' AND jsonb_typeof(a.old_values) = 'object'
                            THEN NOT EXISTS (SELECT 1 FROM jsonb_each(a.old_values) AS e WHERE e.value <> 'null'::jsonb)
                       END
  )) ELSE '{}'::jsonb END`;

type Facts = Record<string, unknown>;

const text = (facts: Facts, name: string): string | null => {
  const value = facts[name];
  return typeof value === 'string' ? value : null;
};
const oneOf = <T extends string>(value: string | null, values: readonly T[]): T | null =>
  value !== null && (values as readonly string[]).includes(value) ? (value as T) : null;
const changedColumns = (facts: Facts): string[] | null => {
  const value = facts.changed;
  return Array.isArray(value) && value.length > 0 && value.every((c) => typeof c === 'string') ? value : null;
};
/** True when every changed column is in `allowed` (so a sentence about them says everything that changed). */
const onlyChanged = (changed: string[] | null, allowed: readonly string[]) =>
  changed !== null && changed.every((c) => allowed.includes(c));

/** The description of one audit entry. Never throws; whatever the input, the result is an event from `AUDIT_EVENTS`. */
export function describeAudit(table: string, operation: string, rawFacts: unknown): AuditDescription {
  if (operation !== 'INSERT' && operation !== 'UPDATE') return { event: 'unknown' };
  const created = operation === 'INSERT';
  if (!(AUDITED_TABLES as readonly string[]).includes(table)) {
    return { event: created ? 'other.created' : 'other.updated' };
  }
  const facts: Facts =
    rawFacts !== null && typeof rawFacts === 'object' && !Array.isArray(rawFacts) ? (rawFacts as Facts) : {};
  const specific = created
    ? describeCreated(table as AuditedTable, facts)
    : describeUpdated(table as AuditedTable, facts, changedColumns(facts));
  return specific ?? { event: `${table}.${created ? 'created' : 'updated'}` };
}

function describeCreated(table: AuditedTable, facts: Facts): AuditDescription | null {
  switch (table) {
    case 'training_applications': {
      const status = oneOf(text(facts, 'newStatus'), APPLICATION_STATUSES);
      return status ? { event: 'application.createdWithStatus', params: { status } } : null;
    }
    case 'application_attachments': {
      const kind = text(facts, 'kind');
      return kind === 'Cv'
        ? { event: 'attachment.cv' }
        : kind === 'UniversityLetter'
          ? { event: 'attachment.universityLetter' }
          : null;
    }
    case 'user_sessions': {
      const owner = text(facts, 'sessionOwner');
      return owner === 'employee'
        ? { event: 'session.startedStaff' }
        : owner === 'trainee'
          ? { event: 'session.startedTrainee' }
          : owner === 'google'
            ? { event: 'session.startedGoogle' }
            : null;
    }
    case 'employees': {
      const role = oneOf(text(facts, 'newRole'), STAFF_ROLES);
      return role ? { event: 'employee.createdWithRole', params: { role } } : null;
    }
    case 'fields': {
      const active = text(facts, 'active');
      return active === 'true'
        ? { event: 'field.createdActive' }
        : active === 'false'
          ? { event: 'field.createdInactive' }
          : null;
    }
    case 'assignments': {
      const fromRequest = facts.fromRequest;
      return fromRequest === true
        ? { event: 'assignment.createdFromRequest' }
        : fromRequest === false
          ? { event: 'assignment.createdDirect' }
          : null;
    }
    case 'notifications': {
      const type = oneOf(text(facts, 'notificationType'), NOTIFICATION_TYPES);
      return type ? { event: `notification.created${type}` } : null;
    }
    default:
      return null; // `<table>.created` already says what was added
  }
}

function describeUpdated(table: AuditedTable, facts: Facts, changed: string[] | null): AuditDescription | null {
  if (!changed) return null;
  switch (table) {
    case 'training_applications': {
      const status = oneOf(text(facts, 'newStatus'), APPLICATION_STATUSES);
      if (!changed.includes('status') || !oneOf(text(facts, 'oldStatus'), APPLICATION_STATUSES)) return null;
      return status === 'UnderReview'
        ? { event: 'application.underReview' }
        : status === 'Accepted'
          ? { event: 'application.accepted' }
          : status === 'Rejected'
            ? { event: 'application.rejected' }
            : null;
    }
    case 'mentor_requests': {
      const status = oneOf(text(facts, 'newStatus'), REQUEST_STATUSES);
      if (!changed.includes('status') || !oneOf(text(facts, 'oldStatus'), REQUEST_STATUSES)) return null;
      return status === 'Approved'
        ? { event: 'mentorRequest.approved' }
        : status === 'Rejected'
          ? { event: 'mentorRequest.rejected' }
          : null;
    }
    case 'assignments': {
      const from = oneOf(text(facts, 'oldStatus'), ASSIGNMENT_STATUSES);
      const to = oneOf(text(facts, 'newStatus'), ASSIGNMENT_STATUSES);
      return changed.includes('status') && from && to && from !== to
        ? { event: 'assignment.statusChanged', params: { fromAssignmentStatus: from, toAssignmentStatus: to } }
        : null;
    }
    case 'employees': {
      const from = oneOf(text(facts, 'oldRole'), STAFF_ROLES);
      const to = oneOf(text(facts, 'newRole'), STAFF_ROLES);
      return changed.includes('role') && from && to && from !== to
        ? { event: 'employee.roleChanged', params: { fromRole: from, toRole: to } }
        : null;
    }
    case 'trainees':
      return onlyChanged(changed, PROFILE_COLUMNS) && facts.profileWasEmpty === true
        ? { event: 'trainee.profileRecorded' }
        : null;
    case 'trainee_sign_in_codes':
      return changed.length !== 1
        ? null
        : changed[0] === 'used_at'
          ? { event: 'signInCode.used' }
          : changed[0] === 'superseded_at'
            ? { event: 'signInCode.superseded' }
            : changed[0] === 'failed_attempts'
              ? { event: 'signInCode.failedAttempt' }
              : null;
    case 'user_sessions': {
      if (!onlyChanged(changed, ['revoked_at', 'revoke_reason'])) return null;
      const reason = text(facts, 'revokeReason');
      return reason === 'SignOut'
        ? { event: 'session.signedOut' }
        : reason === 'Replaced'
          ? { event: 'session.replaced' }
          : null;
    }
    case 'fields': {
      const active = text(facts, 'active');
      if (!changed.includes('is_active') || (active !== 'true' && active !== 'false')) return null;
      const alone = changed.length === 1;
      return active === 'true'
        ? { event: alone ? 'field.activated' : 'field.updatedActivated' }
        : { event: alone ? 'field.deactivated' : 'field.updatedDeactivated' };
    }
    case 'evaluation_criteria':
      return onlyChanged(changed, Object.keys(CRITERION_PROPERTIES))
        ? { event: 'criterion.changed', params: { changes: changed.map((c) => CRITERION_PROPERTIES[c]!) } }
        : null;
    case 'notification_settings':
      return onlyChanged(changed, Object.keys(INTERVAL_PROPERTIES))
        ? { event: 'intervals.changed', params: { changes: changed.map((c) => INTERVAL_PROPERTIES[c]!) } }
        : null;
    case 'certificate_templates':
      return certificateChange(facts, changed);
    case 'notifications':
      return changed.length === 1 && changed[0] === 'is_read' && text(facts, 'read') === 'true'
        ? { event: 'notification.read' }
        : null;
    default:
      return null; // `<table>.updated` is all that can be said
  }
}

/** The template's settings, or one image uploaded, replaced or removed; anything else is "the template was updated". */
function certificateChange(facts: Facts, changed: string[]): AuditDescription | null {
  const rest = changed.filter((c) => c !== 'updated_at');
  if (rest.length === 1 && rest[0] === 'settings') return { event: 'certificate.settingsChanged' };
  for (const image of ['logo', 'signature'] as const) {
    if (!onlyChanged(rest, [`${image}_image`, `${image}_content_type`]) || !rest.includes(`${image}_image`)) continue;
    const action = text(facts, `${image}Action`);
    const name = action && action in IMAGE_ACTIONS ? IMAGE_ACTIONS[action as keyof typeof IMAGE_ACTIONS] : null;
    if (name) return { event: `certificate.${image}${name}` };
  }
  return null;
}
