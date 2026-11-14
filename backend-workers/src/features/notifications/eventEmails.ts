import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import type { Settings } from '../../config';
import type { Queryable } from '../../db';
import type { EmailMessage, EmailSender } from '../../email';
import { renderBilingualHtml, renderBilingualText, type EmailSection } from '../../emailTemplate';

/**
 * Event e-mails of PDF §7 whose workflows exist (AD-59, AD-61): only the e-mail channel the table gives each event,
 * Arabic first then English, HTML with the same plain text (AD-60), sender ProGineer. HR e-mails go separately to every
 * user whose current role is HR (NEW-24), except the mentor-request e-mail, which goes only to the application's current
 * responsible HR (AD-64); the trainee's assignment e-mail names the mentor (NEW-30). The incoming mentor of an executed
 * transfer gets one e-mail (AD-65, owner decision 2026-11-13; an approved addition to the PDF §7 table, AD-59). HR's direct
 * assignment (AD-67) e-mails the assigned employee and the trainee (with the mentor's name and work e-mail and the dates).
 *
 * Delivery is **best effort only**: the e-mail is sent after the business transaction has committed, in the background
 * (`waitUntil`), so a failure never changes or rolls back the business operation. There is **no delivery record, no
 * retry and no failure monitoring** (Phase 3, AD-60 items 5–10, deferred by the owner). Event e-mails are off unless
 * `EVENT_EMAILS=enabled` (off by default in code; enabled for production in wrangler.jsonc since 2026-11-11; off in tests).
 *
 * Phase 3 boundary: `sendEventEmails` is the only place that delivers. Phase 3 replaces it with an enqueue inside the
 * business transaction (the loaders below take any `Queryable`, a transaction included).
 */
export type EventEmailContent =
  | { kind: 'ApplicationSubmitted'; applicationId: string; field: string; applicantName: string | null }
  | { kind: 'ApplicationReceived'; field: string }
  | { kind: 'ApplicationAccepted'; field: string }
  | { kind: 'ApplicationRejected'; field: string; reason: string }
  | { kind: 'MentorRequestSubmitted'; field: string; traineeName: string | null; employeeName: string | null }
  | { kind: 'MentorRequestApproved'; field: string; traineeName: string | null }
  | { kind: 'MentorRequestRejected'; field: string; traineeName: string | null }
  | {
      kind: 'AssignmentApproved';
      field: string;
      startDate: string;
      mentorName: string;
      mentorEmail: string;
    }
  | {
      kind: 'TraineeDirectlyAssigned';
      field: string;
      traineeName: string | null;
      startDate: string;
      plannedEndDate: string;
    }
  | {
      kind: 'DirectAssignmentToTrainee';
      field: string;
      mentorName: string;
      mentorEmail: string;
      startDate: string;
      plannedEndDate: string;
    }
  | {
      kind: 'TrainingTransferredToYou';
      field: string;
      traineeName: string | null;
      mentorName: string;
      effectiveDate: string;
      plannedEndDate: string;
    };

export type EventEmailKind = EventEmailContent['kind'];

export interface EventEmail {
  content: EventEmailContent;
  /** The business record (application, mentor request or executed transfer), for the log only. */
  entityId: string;
  recipient: { type: 'Trainee' | 'Employee'; id: string; email: string };
}

type Section = Omit<EmailSection, 'notes'> & { notes?: string[] };
interface Template {
  ar: Section;
  en: Section;
}

const optional = (label: string, value: string | null) => (value ? [{ label, value }] : []);

/** The bilingual content of each event. Values are plain text; the layout escapes them. */
function template(content: EventEmailContent, site: string): Template {
  const myApplications = {
    ar: { lead: 'لمتابعة طلبك:', label: 'طلباتي', url: `${site}/trainee` },
    en: { lead: 'To follow your application:', label: 'My applications', url: `${site}/trainee` },
  };
  switch (content.kind) {
    case 'ApplicationSubmitted':
      return {
        ar: {
          heading: 'طلب تدريب جديد',
          intro: ['وصل طلب تدريب جديد.'],
          details: [...optional('المتقدم:', content.applicantName), { label: 'المجال:', value: content.field }],
          action: { lead: 'لعرض الطلب:', label: 'عرض الطلب', url: `${site}/hr/applications/${content.applicationId}` },
        },
        en: {
          heading: 'New training application',
          intro: ['A new training application has been submitted.'],
          details: [...optional('Applicant:', content.applicantName), { label: 'Field:', value: content.field }],
          action: {
            lead: 'To view the application:',
            label: 'View application',
            url: `${site}/hr/applications/${content.applicationId}`,
          },
        },
      };
    case 'ApplicationReceived':
      return {
        ar: {
          heading: 'تم استلام طلب التدريب',
          intro: ['استلمنا طلب التدريب الخاص بك. يمكنك متابعة حالته في صفحة «طلباتي».'],
          details: [{ label: 'المجال:', value: content.field }],
          action: myApplications.ar,
        },
        en: {
          heading: 'Training application received',
          intro: [
            'We have received your training application. You can follow its status on the “My applications” page.',
          ],
          details: [{ label: 'Field:', value: content.field }],
          action: myApplications.en,
        },
      };
    case 'ApplicationAccepted':
      return {
        ar: {
          heading: 'تم قبول طلب التدريب',
          intro: ['يسرّنا إبلاغك بأنه تم قبول طلب التدريب الخاص بك.'],
          details: [{ label: 'المجال:', value: content.field }],
          action: myApplications.ar,
        },
        en: {
          heading: 'Training application accepted',
          intro: ['We are pleased to let you know that your training application has been accepted.'],
          details: [{ label: 'Field:', value: content.field }],
          action: myApplications.en,
        },
      };
    case 'ApplicationRejected':
      return {
        ar: {
          heading: 'لم يتم قبول طلب التدريب',
          intro: ['نأسف لإبلاغك بأنه لم يتم قبول طلب التدريب الخاص بك.'],
          details: [
            { label: 'المجال:', value: content.field },
            { label: 'سبب الرفض:', value: content.reason },
          ],
          action: myApplications.ar,
        },
        en: {
          heading: 'Training application not accepted',
          intro: ['We regret to let you know that your training application was not accepted.'],
          details: [
            { label: 'Field:', value: content.field },
            { label: 'Rejection reason:', value: content.reason },
          ],
          action: myApplications.en,
        },
      };
    case 'MentorRequestSubmitted':
      return {
        ar: {
          heading: 'طلب تدريب متدرب',
          intro: ['طلب موظف تدريب متدرب.'],
          details: [
            ...optional('الموظف:', content.employeeName),
            ...optional('المتدرب:', content.traineeName),
            { label: 'المجال:', value: content.field },
          ],
          action: { lead: 'لعرض الطلبات:', label: 'طلبات التدريب من الموظفين', url: `${site}/hr/mentor-requests` },
        },
        en: {
          heading: 'Request to train a trainee',
          intro: ['An employee has asked to train a trainee.'],
          details: [
            ...optional('Employee:', content.employeeName),
            ...optional('Trainee:', content.traineeName),
            { label: 'Field:', value: content.field },
          ],
          action: { lead: 'To view the requests:', label: 'Mentor requests', url: `${site}/hr/mentor-requests` },
        },
      };
    case 'MentorRequestApproved':
      return {
        ar: {
          heading: 'تمت الموافقة على طلب التدريب',
          intro: ['وافقت الموارد البشرية على طلبك لتدريب متدرب.'],
          details: [...optional('المتدرب:', content.traineeName), { label: 'المجال:', value: content.field }],
          action: { lead: 'لعرض متدربيك:', label: 'متدربيني', url: `${site}/employee/trainees` },
        },
        en: {
          heading: 'Training request approved',
          intro: ['HR approved your request to train a trainee.'],
          details: [...optional('Trainee:', content.traineeName), { label: 'Field:', value: content.field }],
          action: { lead: 'To view your trainees:', label: 'My trainees', url: `${site}/employee/trainees` },
        },
      };
    case 'MentorRequestRejected':
      return {
        ar: {
          heading: 'لم تتم الموافقة على طلب التدريب',
          intro: ['لم توافق الموارد البشرية على طلبك لتدريب متدرب.'],
          details: [...optional('المتدرب:', content.traineeName), { label: 'المجال:', value: content.field }],
          action: { lead: 'لعرض المتدربين المتاحين:', label: 'المتدربون المتاحون', url: `${site}/employee/available` },
        },
        en: {
          heading: 'Training request not approved',
          intro: ['HR did not approve your request to train a trainee.'],
          details: [...optional('Trainee:', content.traineeName), { label: 'Field:', value: content.field }],
          action: {
            lead: 'To view available trainees:',
            label: 'Available trainees',
            url: `${site}/employee/available`,
          },
        },
      };
    case 'AssignmentApproved':
      // PDF §7 «اعتماد الربط (تفاصيل البداية والمدرب)»: HR approved the trainee–mentor assignment (not the application,
      // which has its own e-mail). NEW-30: field, start date, the mentor's name and registered work e-mail, nothing more.
      return {
        ar: {
          heading: 'تم اعتماد ربطك بمدرّب',
          intro: ['اعتمدت الموارد البشرية ربطك بمدرّب لتدريبك، وحدّدت تاريخ بدايته.'],
          details: [
            { label: 'المجال:', value: content.field },
            { label: 'تاريخ البداية:', value: content.startDate },
            { label: 'المدرّب:', value: content.mentorName },
            { label: 'البريد الإلكتروني للمدرّب:', value: content.mentorEmail },
          ],
          action: myApplications.ar,
        },
        en: {
          heading: 'Your mentor assignment has been approved',
          intro: ['HR has approved your assignment to a mentor for your training and set its start date.'],
          details: [
            { label: 'Field:', value: content.field },
            { label: 'Start date:', value: content.startDate },
            { label: 'Mentor:', value: content.mentorName },
            { label: 'Mentor’s e-mail:', value: content.mentorEmail },
          ],
          action: myApplications.en,
        },
      };
    case 'TraineeDirectlyAssigned':
      // AD-67: HR assigned the trainee to this employee directly, without a request from them.
      return {
        ar: {
          heading: 'أسندت إليك الموارد البشرية متدربًا',
          intro: ['أسندت الموارد البشرية إليك تدريب متدرب مباشرةً، دون طلب منك.'],
          details: [
            ...optional('المتدرب:', content.traineeName),
            { label: 'المجال:', value: content.field },
            { label: 'تاريخ البداية:', value: content.startDate },
            { label: 'تاريخ الانتهاء المخطط:', value: content.plannedEndDate },
          ],
          action: { lead: 'لعرض متدربيك:', label: 'متدربيني', url: `${site}/employee/trainees` },
        },
        en: {
          heading: 'HR has assigned a trainee to you',
          intro: ["HR has assigned a trainee's training to you directly, without a request from you."],
          details: [
            ...optional('Trainee:', content.traineeName),
            { label: 'Field:', value: content.field },
            { label: 'Start date:', value: content.startDate },
            { label: 'Planned end date:', value: content.plannedEndDate },
          ],
          action: { lead: 'To view your trainees:', label: 'My trainees', url: `${site}/employee/trainees` },
        },
      };
    case 'DirectAssignmentToTrainee':
      // AD-67: the trainee's training with its mentor, assigned directly by HR: the mentor's name and registered work
      // e-mail and the dates, nothing more.
      return {
        ar: {
          heading: 'تم تحديد مدرّبك',
          intro: ['حدّدت الموارد البشرية مدرّبك لتدريبك وتاريخي بدايته وانتهائه المخطط.'],
          details: [
            { label: 'المجال:', value: content.field },
            { label: 'المدرّب:', value: content.mentorName },
            { label: 'البريد الإلكتروني للمدرّب:', value: content.mentorEmail },
            { label: 'تاريخ البداية:', value: content.startDate },
            { label: 'تاريخ الانتهاء المخطط:', value: content.plannedEndDate },
          ],
          action: myApplications.ar,
        },
        en: {
          heading: 'Your mentor has been assigned',
          intro: ["HR has assigned your training's mentor and set its start and planned end dates."],
          details: [
            { label: 'Field:', value: content.field },
            { label: 'Mentor:', value: content.mentorName },
            { label: 'Mentor’s e-mail:', value: content.mentorEmail },
            { label: 'Start date:', value: content.startDate },
            { label: 'Planned end date:', value: content.plannedEndDate },
          ],
          action: myApplications.en,
        },
      };
    case 'TrainingTransferredToYou':
      // AD-65: the incoming mentor of an executed transfer. Only these facts: never the reason, the earlier mentor, the
      // HR member or any note.
      return {
        ar: {
          heading: 'تم نقل متدرب إليك',
          intro: ['نقلت الموارد البشرية تدريب متدرب إليك، وأصبحت المشرف عليه اعتبارًا من تاريخ البداية.'],
          details: [
            ...optional('المتدرب:', content.traineeName),
            { label: 'المشرف:', value: content.mentorName },
            { label: 'المجال:', value: content.field },
            { label: 'تاريخ البداية:', value: content.effectiveDate },
            { label: 'تاريخ الانتهاء المخطط:', value: content.plannedEndDate },
          ],
          action: { lead: 'لعرض متدربيك:', label: 'متدربيني', url: `${site}/employee/trainees` },
        },
        en: {
          heading: 'A trainee has been transferred to you',
          intro: ["HR has transferred a trainee's training to you; you are their mentor from the start date."],
          details: [
            ...optional('Trainee:', content.traineeName),
            { label: 'Mentor:', value: content.mentorName },
            { label: 'Field:', value: content.field },
            { label: 'Start date:', value: content.effectiveDate },
            { label: 'Planned end date:', value: content.plannedEndDate },
          ],
          action: { lead: 'To view your trainees:', label: 'My trainees', url: `${site}/employee/trainees` },
        },
      };
  }
}

/** The complete message of an event: subject Arabic then English, HTML and the equivalent plain text. */
export function renderEventEmail(event: EventEmail, siteBaseUrl: string): EmailMessage {
  const site = siteBaseUrl.replace(/\/+$/, '');
  const { ar, en } = template(event.content, site);
  const arabic: EmailSection = { ...ar, notes: ar.notes ?? [] };
  const english: EmailSection = { ...en, notes: en.notes ?? [] };
  const subject = `${ar.heading} / ${en.heading}`;
  return {
    to: event.recipient.email,
    subject,
    textBody: renderBilingualText(arabic, english),
    htmlBody: renderBilingualHtml(subject, arabic, english),
  };
}

// ── Loaders: read what an event's e-mail needs (after the business change; any Queryable) ──

/** "Application received" to the trainee (PDF §7 «استلام الطلب (تأكيد)»). */
export async function applicationReceivedEmails(q: Queryable, applicationId: string): Promise<EventEmail[]> {
  const { rows } = await q.query<{ trainee_id: string; email: string; field: string }>(
    `SELECT t.id AS trainee_id, t.email, f.name AS field
       FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
      WHERE a.id = $1`,
    [applicationId],
  );
  return rows.map((r) => ({
    content: { kind: 'ApplicationReceived', field: r.field },
    entityId: applicationId,
    recipient: { type: 'Trainee', id: r.trainee_id, email: r.email },
  }));
}

/** "Application accepted or rejected" to the trainee (PDF §7 «قبول الطلب أو رفضه»); the rejection with its reason (AD-61). */
export async function applicationDecisionEmails(q: Queryable, applicationId: string): Promise<EventEmail[]> {
  const { rows } = await q.query<{
    trainee_id: string;
    email: string;
    field: string;
    status: string;
    rejection_reason: string | null;
  }>(
    `SELECT t.id AS trainee_id, t.email, f.name AS field, a.status, a.rejection_reason
       FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
      WHERE a.id = $1`,
    [applicationId],
  );
  return rows.flatMap((r): EventEmail[] => {
    const recipient = { type: 'Trainee' as const, id: r.trainee_id, email: r.email };
    if (r.status === 'Accepted') {
      return [{ content: { kind: 'ApplicationAccepted', field: r.field }, entityId: applicationId, recipient }];
    }
    if (r.status === 'Rejected' && r.rejection_reason !== null) {
      return [
        {
          content: { kind: 'ApplicationRejected', field: r.field, reason: r.rejection_reason },
          entityId: applicationId,
          recipient,
        },
      ];
    }
    return [];
  });
}

/** Every user whose current role is HR, at their registered e-mail address: one separate e-mail each (NEW-24). */
async function hrRecipients(q: Queryable): Promise<EventEmail['recipient'][]> {
  const { rows } = await q.query<{ id: string; email: string }>(
    "SELECT id, email FROM employees WHERE role = 'HR' ORDER BY id",
  );
  return rows.map((r) => ({ type: 'Employee', id: r.id, email: r.email }));
}

/** "New training application" to HR (PDF §7 «طلب تدريب جديد»), one e-mail per HR user. */
export async function applicationSubmittedEmails(q: Queryable, applicationId: string): Promise<EventEmail[]> {
  const { rows } = await q.query<{ applicant_name: string | null; field: string }>(
    `SELECT t.full_name AS applicant_name, f.name AS field
       FROM training_applications a JOIN trainees t ON t.id = a.trainee_id JOIN fields f ON f.id = a.field_id
      WHERE a.id = $1`,
    [applicationId],
  );
  const r = rows[0];
  if (!r) return [];
  return (await hrRecipients(q)).map((recipient) => ({
    content: { kind: 'ApplicationSubmitted', applicationId, field: r.field, applicantName: r.applicant_name },
    entityId: applicationId,
    recipient,
  }));
}

/**
 * "An employee asked to train a trainee" to HR (PDF §7 «موظف طلب تدريب متدرب»): one e-mail to the application's current
 * responsible HR, the recipient the caller resolved in the request's transaction (AD-64; supersedes NEW-24 for this
 * event only).
 */
export async function mentorRequestSubmittedEmails(
  q: Queryable,
  requestId: string,
  recipient: { id: string; email: string },
): Promise<EventEmail[]> {
  const { rows } = await q.query<{ employee_name: string; trainee_name: string | null; field: string }>(
    `SELECT e.full_name AS employee_name, t.full_name AS trainee_name, f.name AS field
       FROM mentor_requests r
       JOIN employees e ON e.id = r.employee_id
       JOIN training_applications a ON a.id = r.application_id
       JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE r.id = $1`,
    [requestId],
  );
  const r = rows[0];
  if (!r) return [];
  return [
    {
      content: {
        kind: 'MentorRequestSubmitted',
        field: r.field,
        traineeName: r.trainee_name,
        employeeName: r.employee_name,
      },
      entityId: requestId,
      recipient: { type: 'Employee', id: recipient.id, email: recipient.email },
    },
  ];
}

/**
 * HR's decision on a mentor request: "approved or rejected" to the employee who asked (PDF §7 «اعتماد الربط أو رفضه»),
 * and on approval "assignment approved" with the start details to the trainee (PDF §7 «اعتماد الربط (تفاصيل البداية
 * والمدرب)»). Application acceptance is a separate action with its own e-mail.
 */
export async function mentorRequestDecisionEmails(q: Queryable, requestId: string): Promise<EventEmail[]> {
  const { rows } = await q.query<{
    status: string;
    employee_id: string;
    employee_email: string;
    employee_name: string;
    trainee_id: string;
    trainee_email: string;
    trainee_name: string | null;
    field: string;
    start_date: string | null;
  }>(
    `SELECT r.status, e.id AS employee_id, e.email AS employee_email, e.full_name AS employee_name,
            t.id AS trainee_id, t.email AS trainee_email,
            t.full_name AS trainee_name, f.name AS field,
            (SELECT s.start_date::text FROM assignments s WHERE s.mentor_request_id = r.id) AS start_date
       FROM mentor_requests r
       JOIN employees e ON e.id = r.employee_id
       JOIN training_applications a ON a.id = r.application_id
       JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE r.id = $1`,
    [requestId],
  );
  const r = rows[0];
  if (!r || (r.status !== 'Approved' && r.status !== 'Rejected')) return [];
  const employee = { type: 'Employee' as const, id: r.employee_id, email: r.employee_email };
  if (r.status === 'Rejected') {
    return [
      {
        content: { kind: 'MentorRequestRejected', field: r.field, traineeName: r.trainee_name },
        entityId: requestId,
        recipient: employee,
      },
    ];
  }
  const events: EventEmail[] = [
    {
      content: { kind: 'MentorRequestApproved', field: r.field, traineeName: r.trainee_name },
      entityId: requestId,
      recipient: employee,
    },
  ];
  if (r.start_date) {
    events.push({
      // The assigned mentor is the employee whose request was approved (the assignment's employee).
      content: {
        kind: 'AssignmentApproved',
        field: r.field,
        startDate: r.start_date,
        mentorName: r.employee_name,
        mentorEmail: r.employee_email,
      },
      entityId: requestId,
      recipient: { type: 'Trainee', id: r.trainee_id, email: r.trainee_email },
    });
  }
  return events;
}

/**
 * AD-67: the e-mails of HR's direct assignment, read after the commit: one to the assigned employee and one to the
 * trainee, at their registered addresses. Nothing for an assignment that came from a mentor request or a transfer.
 */
export async function directAssignmentEmails(q: Queryable, assignmentId: string): Promise<EventEmail[]> {
  const { rows } = await q.query<{
    employee_id: string;
    employee_email: string;
    employee_name: string;
    trainee_id: string;
    trainee_email: string;
    trainee_name: string | null;
    field: string;
    start_date: string;
    end_date: string;
  }>(
    `SELECT e.id AS employee_id, e.email AS employee_email, e.full_name AS employee_name, t.id AS trainee_id,
            t.email AS trainee_email, t.full_name AS trainee_name, f.name AS field, s.start_date::text,
            s.end_date::text
       FROM assignments s
       JOIN employees e ON e.id = s.employee_id
       JOIN training_applications a ON a.id = s.application_id
       JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE s.id = $1 AND s.mentor_request_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM assignment_transfers x WHERE x.to_assignment_id = s.id)`,
    [assignmentId],
  );
  const r = rows[0];
  if (!r) return [];
  return [
    {
      content: {
        kind: 'TraineeDirectlyAssigned',
        field: r.field,
        traineeName: r.trainee_name,
        startDate: r.start_date,
        plannedEndDate: r.end_date,
      },
      entityId: assignmentId,
      recipient: { type: 'Employee', id: r.employee_id, email: r.employee_email },
    },
    {
      content: {
        kind: 'DirectAssignmentToTrainee',
        field: r.field,
        mentorName: r.employee_name,
        mentorEmail: r.employee_email,
        startDate: r.start_date,
        plannedEndDate: r.end_date,
      },
      entityId: assignmentId,
      recipient: { type: 'Trainee', id: r.trainee_id, email: r.trainee_email },
    },
  ];
}

/**
 * AD-65: the incoming mentor's e-mail of each **executed** transfer (`assignment_transfers` ids), at their registered
 * address, with the incoming assignment's dates as they are now. A transfer that is not executed (no link, or its
 * decision not Executed) gives nothing, so Pending, Cancelled and Void decisions never produce an e-mail.
 */
export async function trainingTransferredEmails(q: Queryable, transferIds: string[]): Promise<EventEmail[]> {
  if (transferIds.length === 0) return [];
  const { rows } = await q.query<{
    transfer_id: string;
    employee_id: string;
    employee_email: string;
    employee_name: string;
    trainee_name: string | null;
    field: string;
    start_date: string;
    end_date: string;
  }>(
    `SELECT x.id AS transfer_id, e.id AS employee_id, e.email AS employee_email, e.full_name AS employee_name,
            t.full_name AS trainee_name, f.name AS field, s.start_date::text, s.end_date::text
       FROM assignment_transfers x
       JOIN transfer_decisions d ON d.id = x.decision_id AND d.status = 'Executed'
       JOIN assignments s ON s.id = x.to_assignment_id
       JOIN employees e ON e.id = s.employee_id
       JOIN training_applications a ON a.id = s.application_id
       JOIN trainees t ON t.id = a.trainee_id
       JOIN fields f ON f.id = a.field_id
      WHERE x.id = ANY($1::uuid[])
      ORDER BY x.transferred_at, x.id`,
    [transferIds],
  );
  return rows.map((r) => ({
    content: {
      kind: 'TrainingTransferredToYou',
      field: r.field,
      traineeName: r.trainee_name,
      mentorName: r.employee_name,
      effectiveDate: r.start_date,
      plannedEndDate: r.end_date,
    },
    entityId: r.transfer_id,
    recipient: { type: 'Employee', id: r.employee_id, email: r.employee_email },
  }));
}

/** What delivering event e-mails needs, with or without an HTTP request (the scheduled job has none). */
export interface EventEmailDelivery {
  settings: Pick<Settings, 'eventEmails' | 'trainee'>;
  db: Queryable;
  sender: () => EmailSender;
  waitUntil: (promise: Promise<unknown>) => void;
  traceId?: string;
}

/**
 * Sends the e-mails of an event that has **already committed**, best effort: never throws, never delays the response
 * (each send runs in `waitUntil`). Each outcome is logged by kind and record id only (no recipient, no content; the
 * SMTP sender logs its own error code): a success line too, so a send cut off by the runtime shows as a missing line.
 * These are log lines, not a delivery record (Phase 3). Does nothing, not even the loading query, when disabled.
 */
export async function sendEventEmails(
  c: Context<AppEnv>,
  load: (q: Queryable) => Promise<EventEmail[]>,
): Promise<void> {
  await deliverEventEmails(
    {
      settings: c.var.settings,
      db: c.var.db,
      sender: () => c.var.deps.emailSender(c.var.settings),
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      traceId: c.var.traceId,
    },
    load,
  );
}

/** `sendEventEmails` without an HTTP request (the scheduled job, AD-65); the same behaviour and log lines. */
export async function deliverEventEmails(
  delivery: EventEmailDelivery,
  load: (q: Queryable) => Promise<EventEmail[]>,
): Promise<void> {
  if (!delivery.settings.eventEmails) return;
  let prepared: { event: EventEmail; message: EmailMessage }[];
  try {
    const events = await load(delivery.db);
    prepared = events.map((event) => ({
      event,
      message: renderEventEmail(event, delivery.settings.trainee.signInLinkBaseUrl),
    }));
  } catch {
    console.error(
      JSON.stringify({ level: 'error', message: 'Event e-mails could not be prepared', traceId: delivery.traceId }),
    );
    return;
  }

  const sender = delivery.sender();
  for (const { event, message } of prepared) {
    delivery.waitUntil(
      sender.send(message).then(
        () => {
          console.log(
            JSON.stringify({
              level: 'info',
              message: 'Event e-mail sent (log line only, no delivery record)',
              kind: event.content.kind,
              entityId: event.entityId,
            }),
          );
        },
        () => {
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'Event e-mail was not sent (no retry: delivery tracking is not built)',
              kind: event.content.kind,
              entityId: event.entityId,
            }),
          );
        },
      ),
    );
  }
}
