/**
 * The part of Nodemailer 10 that IMS uses (`src/email.ts`). Nodemailer ships no TypeScript types; declaring only what is
 * used keeps the dependency list to the library itself.
 */
declare module 'nodemailer' {
  export interface SentMessageInfo {
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
  }

  export interface Transporter {
    sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<SentMessageInfo>;
    verify(): Promise<true>;
    close(): void;
  }

  export interface TransportOptions {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    tls: { servername: string; rejectUnauthorized: true };
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
    disableFileAccess: boolean;
    disableUrlAccess: boolean;
    logger: false;
    debug: false;
    getSocket(
      options: unknown,
      callback: (error: Error | null, socketOptions?: { connection: unknown; secured: true }) => void,
    ): void;
  }

  export function createTransport(options: TransportOptions): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
