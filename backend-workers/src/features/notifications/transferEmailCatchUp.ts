import type { Queryable } from '../../db';
import type { EmailMessage } from '../../email';
import { renderEventEmail, trainingTransferredEmails, type EventEmail } from './eventEmails';

/**
 * AD-65: the one-time catch-up of the incoming-mentor e-mail for a transfer executed before that e-mail existed (owner
 * decision 2026-11-13). Not part of the Worker: used only by `scripts/transfer-email-catch-up.ts`, which reads
 * production read-only, sends once and keeps a local record. This module only decides **what** may be sent: exactly one
 * executed transfer, named by its id, to the recipient the operator expects. Nothing here writes to the database.
 */
export class CatchUpRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatchUpRefused';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An address shown without revealing it: first and last character of the local part, the domain kept. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  return `${local[0]}***${local.length > 1 ? local[local.length - 1] : ''}${email.slice(at)}`;
}

/**
 * The e-mail of one executed transfer, refused unless: the id is one exact transfer id (`assignment_transfers.id`, no
 * list, no pattern), that transfer is executed (its decision Executed), it yields exactly one recipient, that recipient
 * matches the masked address the operator confirmed, and the site link is an https URL.
 */
export async function prepareTransferCatchUpEmail(
  q: Queryable,
  options: { transferId: string; expectedMaskedRecipient: string; siteBaseUrl: string },
): Promise<{ event: EventEmail; message: EmailMessage; maskedRecipient: string }> {
  const transferId = options.transferId.trim().toLowerCase();
  if (!UUID.test(transferId)) throw new CatchUpRefused('The transfer id must be one exact transfer id (a UUID).');
  if (!/^https:\/\/[^/\s]+/.test(options.siteBaseUrl)) throw new CatchUpRefused('The site URL must be https.');
  const events = await trainingTransferredEmails(q, [transferId]);
  if (events.length !== 1) {
    throw new CatchUpRefused('No executed transfer has this id (it may be pending, cancelled, void or unknown).');
  }
  const event = events[0]!;
  const maskedRecipient = maskEmail(event.recipient.email);
  if (maskedRecipient !== options.expectedMaskedRecipient) {
    throw new CatchUpRefused('The incoming mentor is not the expected recipient.');
  }
  return { event, message: renderEventEmail(event, options.siteBaseUrl), maskedRecipient };
}

/** The outcome of one SMTP attempt, as the catch-up records it. Only ACCEPTED counts as sent. */
export type CatchUpOutcome = 'ACCEPTED' | 'FAILED' | 'UNKNOWN';

// Refused before any message could be handed over: wrong login, rejected recipient, unknown host, connection refused.
const DEFINITE_FAILURE_CODES = new Set(['EAUTH', 'EENVELOPE', 'EDNS', 'ECONNREFUSED']);

/**
 * Classifies one SMTP attempt without guessing in the sender's favour:
 * - ACCEPTED: the server answered 250 and listed the recipient as accepted, none rejected;
 * - FAILED: the server explicitly refused (an SMTP reply code 4xx/5xx, failed authentication, rejected recipient, unknown
 *   host) or the connection was refused, so the message was certainly not accepted;
 * - UNKNOWN: anything else (a timeout, a dropped connection, an unexpected answer): the server may have accepted it, so
 *   it must not be resent without a manual check.
 */
export function classifySmtpOutcome(
  attempt:
    | { ok: true; info: { accepted?: unknown[]; rejected?: unknown[]; response?: string; messageId?: string } }
    | { ok: false; error: unknown },
  recipient: string,
): CatchUpOutcome {
  if (attempt.ok) {
    const accepted = (attempt.info.accepted ?? []).map((a) => String(a).toLowerCase());
    const rejected = attempt.info.rejected ?? [];
    return accepted.includes(recipient.toLowerCase()) &&
      rejected.length === 0 &&
      /^250\b/.test(attempt.info.response ?? '')
      ? 'ACCEPTED'
      : 'UNKNOWN';
  }
  const error = attempt.error as { code?: unknown; responseCode?: unknown } | null;
  if (typeof error?.responseCode === 'number' && error.responseCode >= 400 && error.responseCode < 600) return 'FAILED';
  if (typeof error?.code === 'string' && DEFINITE_FAILURE_CODES.has(error.code)) return 'FAILED';
  return 'UNKNOWN';
}
