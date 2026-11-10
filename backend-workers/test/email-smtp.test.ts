import { env } from 'cloudflare:test';
import type { TransportOptions, Transporter } from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, type Bindings, type SmtpSettings } from '../src/config';
import { EmailSendError } from '../src/domain/errors';
import { emailSenderFor, smtpEmailSender, smtpTransportOptions, type TransportFactory } from '../src/email';
import { body, createTestApi, uniqueEmail, withDb } from './helpers';

/**
 * E-mail through SMTP (Gmail with an App Password, via Nodemailer; owner request 2026-11-10, local development). No test
 * here, or anywhere else, reaches a mail server: the transport is a fake that records what it was asked to send.
 */
const PASSWORD = 'abcdefghijklmnop';
const USER = 'ims.sender@gmail.example';
const SMTP: SmtpSettings = { host: 'smtp.gmail.com', port: 465, user: USER, password: PASSWORD };

const base: Bindings = {
  ENVIRONMENT: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db?sslmode=disable',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
};
const settingsWith = (extra: Partial<Bindings>) => loadSettings({ ...base, ...extra });
const configError = (extra: Partial<Bindings>) => {
  try {
    settingsWith(extra);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('Expected a configuration error.');
};

/** A transport that records sendMail calls, or fails with `failure`. */
function fakeTransport(failure?: Record<string, unknown>) {
  const sent: unknown[] = [];
  const options: TransportOptions[] = [];
  let closed = 0;
  const factory: TransportFactory = (o) => {
    options.push(o);
    return {
      async sendMail(message) {
        if (failure) throw Object.assign(new Error(String(failure.message ?? 'failure')), failure);
        sent.push(message);
        return { messageId: '<x@gmail.example>', response: '250 2.0.0 OK' };
      },
      async verify() {
        return true as const;
      },
      close() {
        closed++;
      },
    } satisfies Transporter;
  };
  return { factory, sent, options, closed: () => closed };
}

afterEach(() => vi.restoreAllMocks());

describe('SMTP configuration', () => {
  it('reads the SMTP settings, with Gmail and port 465 as defaults, ignoring spaces in the App Password', () => {
    const settings = settingsWith({
      EMAIL_PROVIDER: 'smtp',
      SMTP_USER: USER,
      SMTP_APP_PASSWORD: 'abcd efgh ijkl mnop',
    });
    expect(settings.emailProvider).toBe('smtp');
    expect(settings.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, user: USER, password: PASSWORD });
  });

  it('refuses a missing account or password, a port other than 465, and an invalid host, without quoting the password', () => {
    expect(configError({ EMAIL_PROVIDER: 'smtp', SMTP_APP_PASSWORD: PASSWORD })).toMatch(/SMTP_USER/);
    expect(configError({ EMAIL_PROVIDER: 'smtp', SMTP_USER: 'not-an-address', SMTP_APP_PASSWORD: PASSWORD })).toMatch(
      /SMTP_USER/,
    );
    expect(configError({ EMAIL_PROVIDER: 'smtp', SMTP_USER: USER })).toMatch(/SMTP_APP_PASSWORD/);
    expect(configError({ EMAIL_PROVIDER: 'smtp', SMTP_USER: USER, SMTP_APP_PASSWORD: '   ' })).toMatch(
      /SMTP_APP_PASSWORD/,
    );
    for (const port of ['587', '25', 'abc']) {
      const message = configError({
        EMAIL_PROVIDER: 'smtp',
        SMTP_USER: USER,
        SMTP_APP_PASSWORD: PASSWORD,
        SMTP_PORT: port,
      });
      expect(message).toMatch(/SMTP_PORT must be 465/);
      expect(message).not.toContain(PASSWORD);
    }
    expect(
      configError({ EMAIL_PROVIDER: 'smtp', SMTP_USER: USER, SMTP_APP_PASSWORD: PASSWORD, SMTP_HOST: 'http://x' }),
    ).toMatch(/SMTP_HOST/);
    expect(configError({ EMAIL_PROVIDER: 'mailgun' })).toMatch(/not supported/);
  });

  it('keeps the log provider for development only, and no provider when none is set', () => {
    expect(settingsWith({ EMAIL_PROVIDER: 'log' }).emailProvider).toBe('log');
    expect(
      settingsWith({
        EMAIL_PROVIDER: 'log',
        ENVIRONMENT: 'production',
        DATABASE_URL: 'postgres://u:p@h/db?sslmode=verify-full',
      }).emailProvider,
    ).toBe('none');
    expect(settingsWith({}).emailProvider).toBe('none');
    expect(settingsWith({}).smtp).toBeNull();
  });

  it('the test environment configures no mail server, so ordinary tests can never send a real e-mail', () => {
    const bindings = env as unknown as Record<string, unknown>;
    expect(bindings.EMAIL_PROVIDER).toBe(''); // the test configuration overrides wrangler.jsonc's `smtp`
    // No credentials reach the tests, even when a developer's .dev.vars has real ones (vitest.config.ts blanks them).
    expect(bindings.SMTP_USER ?? '').toBe('');
    expect(bindings.SMTP_APP_PASSWORD ?? '').toBe('');
    expect(loadSettings(env as unknown as Bindings).emailProvider).toBe('none');
  });
});

describe('SMTP transport options', () => {
  it('use TLS from the first byte with certificate checks for the configured host, and no file or URL access', () => {
    const options = smtpTransportOptions(SMTP);
    expect(options).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: USER, pass: PASSWORD },
      tls: { servername: 'smtp.gmail.com', rejectUnauthorized: true },
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    expect(typeof options.getSocket).toBe('function'); // the socket is opened by host name (a Worker cannot dial an IP)
  });
});

describe('sending through SMTP (fake transport)', () => {
  it('sends from the SMTP account with the display name ProGineer, as text and HTML, then closes the connection', async () => {
    const transport = fakeTransport();
    await smtpEmailSender(SMTP, transport.factory).send({
      to: 'trainee@uni.example',
      subject: 'S',
      textBody: 'B',
      htmlBody: '<p>B</p>',
    });
    expect(transport.sent).toEqual([
      {
        from: { name: 'ProGineer', address: USER },
        to: 'trainee@uni.example',
        subject: 'S',
        text: 'B',
        html: '<p>B</p>',
      },
    ]);
    expect(transport.closed()).toBe(1);
  });

  it.each([
    [
      'an authentication failure',
      { code: 'EAUTH', responseCode: 535, message: `535-5.7.8 Username and Password not accepted for ${USER}` },
      'EAUTH',
      535,
    ],
    ['a TLS failure', { code: 'ESOCKET', message: 'certificate has expired' }, 'ESOCKET', null],
    ['a timeout', { code: 'ETIMEDOUT', message: 'Greeting never received' }, 'ETIMEDOUT', null],
    ['an unknown failure', { code: `X-${PASSWORD}`, message: `boom ${PASSWORD}` }, 'UNKNOWN', null],
  ])('reports %s as EmailSendError, logging only the error code', async (_case, failure, code, responseCode) => {
    const logged: string[] = [];
    for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    }
    const transport = fakeTransport(failure);
    const sending = smtpEmailSender(SMTP, transport.factory).send({
      to: 'private.person@uni.example',
      subject: 'Code 123456',
      textBody: 'secret code 123456',
      htmlBody: '<p>secret code 123456</p>',
    });
    await expect(sending).rejects.toBeInstanceOf(EmailSendError);
    expect(transport.closed()).toBe(1);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toEqual({ level: 'error', message: 'E-mail could not be sent', code, responseCode });
    const all = logged.join('\n');
    for (const secret of [
      PASSWORD,
      USER,
      'private.person@uni.example',
      '123456',
      'Username and Password',
      'certificate',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('is what the configuration selects', async () => {
    const settings = settingsWith({ EMAIL_PROVIDER: 'smtp', SMTP_USER: USER, SMTP_APP_PASSWORD: PASSWORD });
    const sender = emailSenderFor(settings);
    expect(sender).not.toBe(emailSenderFor(settingsWith({ EMAIL_PROVIDER: 'log' })));
    expect(typeof sender.send).toBe('function');
  });
});

describe('trainee sign-in with SMTP (fake transport)', () => {
  it('delivers the sign-in e-mail through SMTP and stores the code', async () => {
    const transport = fakeTransport();
    const api = createTestApi({ emailSender: () => smtpEmailSender(SMTP, transport.factory) });
    const email = uniqueEmail();
    expect((await api.client().post('/api/auth/trainee/request', { email })).status).toBe(202);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ from: { name: 'ProGineer', address: USER }, to: email });
    const { text, html } = transport.sent[0] as { text: string; html: string };
    const code = /\b(\d{6})\b/.exec(text)![1]!;
    expect(html).toContain(`>${code}</p>`); // the same code in the HTML part
    const stored = await withDb((db) => db.query('SELECT 1 FROM trainee_sign_in_codes WHERE email = $1', [email]));
    expect(stored.rowCount).toBe(1);
  });

  it('a failed send answers 503 without details, and stores no code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transport = fakeTransport({ code: 'EAUTH', responseCode: 535, message: `Invalid login for ${USER}` });
    const api = createTestApi({ emailSender: () => smtpEmailSender(SMTP, transport.factory) });
    const email = uniqueEmail();
    const response = await api.client().post('/api/auth/trainee/request', { email });
    expect(response.status).toBe(503);
    const text = JSON.stringify(await body(response));
    expect(JSON.parse(text)).toMatchObject({ status: 503, code: 'email.send_failed' });
    for (const secret of [PASSWORD, USER, 'Invalid login', 'EAUTH']) expect(text).not.toContain(secret);
    const stored = await withDb((db) => db.query('SELECT 1 FROM trainee_sign_in_codes WHERE email = $1', [email]));
    expect(stored.rowCount).toBe(0); // sent before saving: nothing undeliverable is kept
  });
});
