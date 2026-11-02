import type { Settings } from './config';
import { EmailNotConfiguredError } from './domain/errors';

/** Sends e-mail. The production provider (SendGrid or Amazon SES, PDF §9) is not chosen yet (Q10). */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  textBody: string;
}

/** Development only: writes e-mails to the Worker log instead of sending them (same text as the C# LogEmailSender). */
export const logEmailSender: EmailSender = {
  async send(message) {
    console.warn(`DEVELOPMENT E-MAIL (not sent) to ${message.to}\nSubject: ${message.subject}\n${message.textBody}`);
  },
};

/** No provider configured: fail loudly (HTTP 503) instead of silently dropping sign-in codes. */
export const unconfiguredEmailSender: EmailSender = {
  async send() {
    throw new EmailNotConfiguredError();
  },
};

export function emailSenderFor(settings: Settings): EmailSender {
  return settings.emailProvider === 'log' ? logEmailSender : unconfiguredEmailSender;
}
