import type { Queryable } from '../../db';
import { calendarDate, OFFICIAL_TIME_ZONE } from '../../domain/training';
import { uuidV7 } from '../../domain/uuid';
import type { EmailSender } from '../../email';
import { SCHEDULER_ACTOR, type TransactionalDatabase } from '../training/transfers';
import { CURRENT_RESPONSIBLE_HR_ID } from '../training/responsibleHr';
import { hrRecipients, renderEventEmail, type EventEmail } from './eventEmails';

/**
 * The pending-request reminder (PDF §7 «طلب معلّق أكثر من 5 أيام»; AD-61 items 4–17, NEW-05): one e-mail reminder to
 * HR, once, about each request still waiting for an HR decision after N × 24 hours of actual elapsed time, N being the
 * Admin setting `notification_settings.pending_request_alert_days` read at each check:
 * - a training application `Submitted` or `UnderReview`, counted from `submitted_at` (Under Review does not restart it),
 *   to every user who holds the HR role at the time of the check, one e-mail each (item 10);
 * - a mentor request `Pending`, counted from `requested_at`, to the application's current responsible HR (AD-64) only,
 *   and only while that user holds the HR role (item 10, rule 7 of AD-64).
 * Accepted, Rejected and Approved requests (including AD-67's automatic rejections) are never reminded (items 8, 11).
 *
 * Launch cutoff (AD-61 item 18, owner revision 2026-11-15, supersedes the inclusion of pre-launch requests in item 13):
 * only a request created at or after NEW-05's first production activation can be reminded: an application whose
 * `submitted_at` and a mentor request whose own `requested_at` is `>=` the activation instant (one cutoff for both;
 * an older application moved to Under Review later stays excluded). The instant is the Worker variable
 * `PENDING_REMINDERS_ACTIVATED_AT` (a UTC timestamp, set once at the first activation and never changed); when it is
 * missing or invalid nothing is read, claimed or sent (fail closed). It is checked in the candidate query and again
 * under the row lock of the claim.
 *
 * Exactly once (items 5, 7, 13): `pending_reminders` holds at most one row per request (unique). A row is written only
 * when the reminder is actually attempted: event e-mails enabled (item 16) and at least one eligible recipient (item
 * 15). So a request with nobody to remind, or checked while e-mails are off, stays eligible and is caught up by a later
 * check, as is every post-launch request a missed run did not reach (item 13). Nobody else is ever reminded instead.
 *
 * Each request is claimed in its own short transaction (System actor, audited): the request row is locked, its status,
 * age and the absence of a reminder are checked again, the recipients are read, and the reminder is recorded as
 * `Attempting`. The transaction commits **before** any e-mail is sent: no transaction is open during SMTP. A concurrent
 * run waits on the lock and then finds the reminder (and the unique index refuses a duplicate in any case). Each e-mail
 * is then attempted once, in turn (best effort, no retry, no queue: item 17), and a second short transaction records
 * what the SMTP server answered (accepted, partially accepted or failed; acceptance is not inbox delivery).
 * Residual risk: if the run stops between the claim and the outcome (the Worker is cut off, or the database is
 * unreachable for the second write), the row stays `Attempting`: the outcome of those sends is unknown, and the
 * request is never reminded again. That is the "at most once" side the owner accepted for failures (item 17).
 */

/** The Cron Trigger of this job (wrangler.jsonc): 06:00 and 07:00 UTC, one of which is 09:00 Asia/Hebron. */
export const PENDING_REMINDER_CRON = '0 6,7 * * *';
/** The daily check runs at 09:00 Asia/Hebron (AD-61 item 13, AD-62). */
export const PENDING_REMINDER_LOCAL_HOUR = 9;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The hour (0–23) of `instant` in Asia/Hebron, daylight saving included. */
export function officialHour(instant: Date): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: OFFICIAL_TIME_ZONE, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(instant)
    .find((part) => part.type === 'hour')!.value;
  return Number(hour) % 24;
}

/**
 * Whether a run of the Cron Trigger at `instant` is the daily check: Cron Triggers are UTC, and Asia/Hebron is UTC+2 in
 * winter and UTC+3 in summer, so the trigger fires at 06:00 and 07:00 UTC and only the run at 09:xx local time checks.
 */
export function isPendingReminderRun(instant: Date): boolean {
  return officialHour(instant) === PENDING_REMINDER_LOCAL_HOUR;
}

/**
 * A request started at `startedAt` is overdue at `now` once N × 24 hours have actually elapsed (item 12): at exactly
 * N × 24 hours it is due. Calendar days and the time zone play no part.
 */
export function isOverdue(startedAt: Date, now: Date, thresholdDays: number): boolean {
  return now.getTime() - startedAt.getTime() >= thresholdDays * DAY_MS;
}

/**
 * The launch cutoff (AD-61 item 18) from `PENDING_REMINDERS_ACTIVATED_AT`: a UTC timestamp written exactly as
 * `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DDTHH:MM:SS.sssZ`, a real calendar instant. Anything else (missing, empty, another
 * format or time zone, an impossible date) is null, and the job then does nothing.
 */
export function parseActivationCutoff(value: string | undefined | null): Date | null {
  const text = value?.trim() ?? '';
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/.exec(text);
  if (!match) return null;
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) return null;
  // Refuses dates the parser would roll over (2026-02-30) or clamp: the instant must print back as written.
  return instant.toISOString() === `${match[1]}${match[2] ?? '.000'}Z` ? instant : null;
}

/** The current Admin setting `pending_request_alert_days` (seeded by the AdminModule migration). */
export async function pendingRequestAlertDays(q: Queryable): Promise<number> {
  const { rows } = await q.query<{ days: number }>(
    'SELECT pending_request_alert_days AS days FROM notification_settings WHERE id = 1',
  );
  const days = rows[0]?.days;
  if (!days || days < 1) throw new Error('The notification_settings row (id = 1) is missing or invalid.');
  return days;
}

export interface PendingReminderSummary {
  thresholdDays: number;
  /** The launch cutoff applied (AD-61 item 18). */
  activatedAt: string;
  /** Overdue requests not yet reminded, as first selected. */
  candidates: number;
  /** Reminders claimed and attempted by this run. */
  attempted: number;
  /** Overdue requests left eligible because nobody may receive their reminder now (item 15). */
  noRecipient: number;
  /** Requests decided, already reminded (by a concurrent run) or no longer due when claimed. */
  skipped: number;
  /** Requests whose claim failed (left eligible for the next run). */
  failed: number;
  /** E-mails the SMTP server accepted (not confirmed inbox delivery). */
  emailsAccepted: number;
  emailsFailed: number;
}

type Candidate = { kind: 'TrainingApplication' | 'MentorRequest'; id: string };

/**
 * The daily check. `eventEmails` is the EVENT_EMAILS setting: when it is off nothing is read, attempted or recorded
 * (item 16), and the overdue requests are caught up once it is on. `activatedAt` is the launch cutoff (item 18): when it
 * is not a valid instant nothing is read, attempted or recorded either. Never sends twice for one request.
 */
export async function remindPendingRequests(
  db: TransactionalDatabase,
  options: {
    now: Date;
    eventEmails: boolean;
    activatedAt: Date | null;
    sender: () => EmailSender;
    siteBaseUrl: string;
  },
): Promise<PendingReminderSummary | null> {
  if (!options.eventEmails) return null;
  const activatedAt = options.activatedAt;
  if (!(activatedAt instanceof Date) || Number.isNaN(activatedAt.getTime())) return null; // fail closed
  const { now } = options;
  const thresholdDays = await pendingRequestAlertDays(db);
  const cutoff = new Date(now.getTime() - thresholdDays * DAY_MS);
  const { rows: candidates } = await db.query<Candidate>(
    `SELECT 'TrainingApplication' AS kind, a.id, a.submitted_at AS started_at
       FROM training_applications a
      WHERE a.status IN ('Submitted', 'UnderReview') AND a.submitted_at <= $1 AND a.submitted_at >= $2
        AND NOT EXISTS (SELECT 1 FROM pending_reminders p WHERE p.application_id = a.id)
     UNION ALL
     SELECT 'MentorRequest' AS kind, r.id, r.requested_at AS started_at
       FROM mentor_requests r
      WHERE r.status = 'Pending' AND r.requested_at <= $1 AND r.requested_at >= $2
        AND NOT EXISTS (SELECT 1 FROM pending_reminders p WHERE p.mentor_request_id = r.id)
     ORDER BY started_at, id`,
    [cutoff, activatedAt],
  );
  const summary: PendingReminderSummary = {
    thresholdDays,
    activatedAt: activatedAt.toISOString(),
    candidates: candidates.length,
    attempted: 0,
    noRecipient: 0,
    skipped: 0,
    failed: 0,
    emailsAccepted: 0,
    emailsFailed: 0,
  };
  let sender: EmailSender | null = null;
  for (const candidate of candidates) {
    let claim: Claim;
    try {
      claim = await db.transaction(SCHEDULER_ACTOR, (tx) =>
        claimReminder(tx, candidate, now, thresholdDays, activatedAt),
      );
    } catch (error) {
      summary.failed += 1;
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Pending-request reminder could not be claimed; it stays eligible for the next run',
          kind: candidate.kind,
          entityId: candidate.id,
          error: error instanceof Error ? error.name : 'Error',
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined,
        }),
      );
      continue;
    }
    if (claim.result === 'skipped') {
      summary.skipped += 1;
      continue;
    }
    if (claim.result === 'no_recipient') {
      summary.noRecipient += 1;
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Pending-request reminder not sent: no eligible HR recipient now; it stays eligible',
          kind: candidate.kind,
          entityId: candidate.id,
        }),
      );
      continue;
    }

    // Committed: the reminder is this run's. Each e-mail is attempted once, outside any transaction.
    summary.attempted += 1;
    sender ??= options.sender();
    let accepted = 0;
    let failed = 0;
    for (const event of claim.emails) {
      try {
        await sender.send(renderEventEmail(event, options.siteBaseUrl));
        accepted += 1;
        console.log(
          JSON.stringify({
            level: 'info',
            message: 'Event e-mail sent (log line only, no delivery record)',
            kind: event.content.kind,
            entityId: event.entityId,
          }),
        );
      } catch {
        failed += 1;
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Event e-mail was not sent (no retry: delivery tracking is not built)',
            kind: event.content.kind,
            entityId: event.entityId,
          }),
        );
      }
    }
    summary.emailsAccepted += accepted;
    summary.emailsFailed += failed;
    try {
      await db.transaction(SCHEDULER_ACTOR, (tx) =>
        tx.query(
          `UPDATE pending_reminders
              SET outcome = CASE WHEN $3::int = 0 THEN 'Accepted' WHEN $2::int = 0 THEN 'Failed'
                                 ELSE 'PartiallyAccepted' END,
                  accepted_count = $2, failed_count = $3, completed_at = $4
            WHERE id = $1 AND outcome = 'Attempting'`,
          [claim.reminderId, accepted, failed, now],
        ),
      );
    } catch {
      // The e-mails were attempted; only their record is missing. The row stays Attempting and is never resent.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Pending-request reminder outcome could not be recorded; it stays Attempting and is not resent',
          kind: candidate.kind,
          entityId: candidate.id,
        }),
      );
    }
  }
  return summary;
}

type Claim =
  | { result: 'skipped' }
  | { result: 'no_recipient' }
  | { result: 'claimed'; reminderId: string; emails: EventEmail[] };

/** One request, in the claim transaction: re-checked under its row lock, then recorded as Attempting with its e-mails. */
async function claimReminder(
  tx: Queryable,
  candidate: Candidate,
  now: Date,
  thresholdDays: number,
  activatedAt: Date,
): Promise<Claim> {
  const emails =
    candidate.kind === 'TrainingApplication'
      ? await applicationReminder(tx, candidate.id, now, thresholdDays, activatedAt)
      : await mentorRequestReminder(tx, candidate.id, now, thresholdDays, activatedAt);
  if (emails === null) return { result: 'skipped' };
  if (emails.length === 0) return { result: 'no_recipient' };
  const reminderId = uuidV7(now);
  const { rowCount } = await tx.query(
    `INSERT INTO pending_reminders (id, kind, application_id, mentor_request_id, attempted_at, recipient_count, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, 'Attempting')
     ON CONFLICT DO NOTHING`,
    [
      reminderId,
      candidate.kind,
      candidate.kind === 'TrainingApplication' ? candidate.id : null,
      candidate.kind === 'MentorRequest' ? candidate.id : null,
      now,
      emails.length,
    ],
  );
  return rowCount === 1 ? { result: 'claimed', reminderId, emails } : { result: 'skipped' };
}

/** null: not (or no longer) due; []: due, but nobody holds the HR role now. */
async function applicationReminder(
  tx: Queryable,
  applicationId: string,
  now: Date,
  thresholdDays: number,
  activatedAt: Date,
): Promise<EventEmail[] | null> {
  const { rows } = await tx.query<{
    status: 'Submitted' | 'UnderReview';
    submitted_at: Date;
    applicant_name: string | null;
    field: string;
    reminded: boolean;
  }>(
    `SELECT a.status, a.submitted_at, t.full_name AS applicant_name, f.name AS field,
            EXISTS (SELECT 1 FROM pending_reminders p WHERE p.application_id = a.id) AS reminded
       FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
      WHERE a.id = $1
        FOR UPDATE OF a`,
    [applicationId],
  );
  const r = rows[0];
  if (!r || r.reminded || !['Submitted', 'UnderReview'].includes(r.status)) return null;
  const submittedAt = new Date(r.submitted_at);
  if (submittedAt < activatedAt || !isOverdue(submittedAt, now, thresholdDays)) return null; // item 18, item 12
  return (await hrRecipients(tx)).map((recipient) => ({
    content: {
      kind: 'PendingApplicationReminder',
      applicationId,
      field: r.field,
      applicantName: r.applicant_name,
      status: r.status,
      submittedDate: calendarDate(new Date(r.submitted_at)),
      thresholdDays,
    },
    entityId: applicationId,
    recipient,
  }));
}

/** null: not (or no longer) due; []: due, but the current responsible HR does not hold the HR role now. */
async function mentorRequestReminder(
  tx: Queryable,
  requestId: string,
  now: Date,
  thresholdDays: number,
  activatedAt: Date,
): Promise<EventEmail[] | null> {
  const { rows } = await tx.query<{
    status: string;
    requested_at: Date;
    employee_name: string;
    trainee_name: string | null;
    field: string;
    reminded: boolean;
    hr_id: string | null;
    hr_email: string | null;
  }>(
    `SELECT r.status, r.requested_at, e.full_name AS employee_name, t.full_name AS trainee_name, f.name AS field,
            EXISTS (SELECT 1 FROM pending_reminders p WHERE p.mentor_request_id = r.id) AS reminded,
            hr.id AS hr_id, hr.email AS hr_email
       FROM mentor_requests r
       JOIN employees e ON e.id = r.employee_id
       JOIN training_applications a ON a.id = r.application_id
       JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
       LEFT JOIN employees hr ON hr.id = ${CURRENT_RESPONSIBLE_HR_ID} AND hr.role = 'HR' AND a.status = 'Accepted'
      WHERE r.id = $1
        FOR UPDATE OF r`,
    [requestId],
  );
  const r = rows[0];
  if (!r || r.reminded || r.status !== 'Pending') return null;
  const requestedAt = new Date(r.requested_at);
  if (requestedAt < activatedAt || !isOverdue(requestedAt, now, thresholdDays)) return null; // item 18, item 12
  if (!r.hr_id || !r.hr_email) return [];
  return [
    {
      content: {
        kind: 'PendingMentorRequestReminder',
        field: r.field,
        traineeName: r.trainee_name,
        employeeName: r.employee_name,
        requestedDate: calendarDate(new Date(r.requested_at)),
        thresholdDays,
      },
      entityId: requestId,
      recipient: { type: 'Employee', id: r.hr_id, email: r.hr_email },
    },
  ];
}
