import { connect as tlsConnect } from 'node:tls';
import nodemailer, { type TransportOptions, type Transporter } from 'nodemailer';
import type { Settings, SmtpSettings } from './config';
import { EmailNotConfiguredError, EmailSendError } from './domain/errors';

/**
 * Sends e-mail. Providers: `log` (development only), `smtp` (for example Gmail with an App Password, through
 * Nodemailer), or none. SendGrid was selected for production (AD-53) but is not implemented.
 */
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

/** Creates the Nodemailer transport; tests pass a fake one instead, so no test ever reaches a real server. */
export type TransportFactory = (options: TransportOptions) => Transporter;

const SMTP_ERROR_CODES = [
  'EAUTH',
  'ECONNECTION',
  'EDNS',
  'EENVELOPE',
  'EMESSAGE',
  'EPROTOCOL',
  'ESOCKET',
  'ETIMEDOUT',
  'ETLS',
];

/**
 * The Nodemailer options for `smtp`. TLS from the first byte (port 465), certificates always verified (the Workers
 * runtime has no way to turn that off) for the configured host name. The socket is opened here by host name: Nodemailer
 * would otherwise look the host up and connect to the IP address, which a Worker may not do (verified 2026-11-10).
 */
export function smtpTransportOptions(smtp: SmtpSettings): TransportOptions {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: true,
    auth: { user: smtp.user, pass: smtp.password },
    tls: { servername: smtp.host, rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
    getSocket(_options, callback) {
      const socket = tlsConnect({ host: smtp.host, port: smtp.port, servername: smtp.host, rejectUnauthorized: true });
      let answered = false;
      const answer = (error: Error | null) => {
        if (answered) return;
        answered = true;
        if (error) callback(error);
        else callback(null, { connection: socket, secured: true });
      };
      socket.once('secureConnect', () => answer(null));
      socket.once('error', (error) => answer(error));
    },
  };
}

/**
 * Sends through an SMTP server, from the SMTP account's own address. A failure is logged by its error code only (never
 * the server's text, the recipient or any credential) and becomes EmailSendError (HTTP 503).
 */
export function smtpEmailSender(
  smtp: SmtpSettings,
  createTransport: TransportFactory = nodemailer.createTransport,
): EmailSender {
  return {
    async send(message) {
      const transport = createTransport(smtpTransportOptions(smtp));
      try {
        await transport.sendMail({ from: smtp.user, to: message.to, subject: message.subject, text: message.textBody });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        const responseCode = (error as { responseCode?: unknown } | null)?.responseCode;
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'E-mail could not be sent',
            code: typeof code === 'string' && SMTP_ERROR_CODES.includes(code) ? code : 'UNKNOWN',
            responseCode: typeof responseCode === 'number' ? responseCode : null,
          }),
        );
        throw new EmailSendError();
      } finally {
        transport.close();
      }
    },
  };
}

export function emailSenderFor(settings: Settings): EmailSender {
  if (settings.emailProvider === 'smtp' && settings.smtp) return smtpEmailSender(settings.smtp);
  return settings.emailProvider === 'log' ? logEmailSender : unconfiguredEmailSender;
}
