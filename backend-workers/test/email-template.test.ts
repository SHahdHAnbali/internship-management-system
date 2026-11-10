import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { loadSettings, type Bindings, type SmtpSettings } from '../src/config';
import { smtpEmailSender, type EmailMessage, type TransportFactory } from '../src/email';
import { escapeHtml, renderBilingualHtml, type EmailSection } from '../src/emailTemplate';
import { buildMessage } from '../src/features/auth/traineeSignIn';
import { body, createTestApi, uniqueEmail, withDb } from './helpers';

/**
 * The e-mail format (AD-60): display name ProGineer, HTML with an equivalent plain text, Arabic first then English in
 * both. No test here reaches a mail server: the MIME test composes the message with Nodemailer's in-memory transport.
 */
const settings = (extra: Partial<Bindings> = {}) =>
  loadSettings({
    ENVIRONMENT: 'development',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db?sslmode=disable',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
    TRAINEE_SIGN_IN_LINK_BASE_URL: 'https://ims.example/',
    ...extra,
  });
const TOKEN = 'AbC-123_xyz';
const CODE = '042517';
const LINK = `https://ims.example/sign-in/verify?token=${TOKEN}`;

/** The HTML's text with tags removed and the five escaped characters restored. */
function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const arabicSection = (html: string) => html.indexOf('<div dir="rtl" lang="ar"');
const englishSection = (html: string) => html.indexOf('<div dir="ltr" lang="en"');

describe('the sign-in e-mail (AD-60)', () => {
  const message: EmailMessage = buildMessage(settings(), 'trainee@uni.example', TOKEN, CODE);

  it('keeps the subject and the plain text unchanged: Arabic first, then English, with the code and the link in each', () => {
    expect(message.subject).toBe(`رمز الدخول / Sign-in code: ${CODE}`);
    expect(message.textBody).toBe(
      [
        `رمز الدخول إلى نظام إدارة المتدربين: ${CODE}`,
        'أو افتح هذا الرابط لتسجيل الدخول مباشرة:',
        LINK,
        'الرمز والرابط صالحان لمدة 15 دقيقة ولمرة واحدة فقط. إذا لم تطلب ذلك فتجاهل هذه الرسالة.',
        '',
        `Your Trainee Management System sign-in code: ${CODE}`,
        'Or open this link to sign in directly:',
        LINK,
        'The code and link are valid for 15 minutes and can be used once. If you did not request this, ignore this e-mail.',
      ].join('\n'),
    );
  });

  it('has an HTML part with an Arabic right-to-left section before an English left-to-right one', () => {
    const html = message.htmlBody;
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(arabicSection(html)).toBeGreaterThan(0);
    expect(englishSection(html)).toBeGreaterThan(arabicSection(html));
    expect(html.match(/<div dir="rtl" lang="ar"/g)).toHaveLength(1);
    expect(html.match(/<div dir="ltr" lang="en"/g)).toHaveLength(1);
    expect(html.indexOf('رمز الدخول إلى نظام إدارة المتدربين:')).toBeLessThan(englishSection(html));
    expect(html.indexOf('Your Trainee Management System sign-in code:')).toBeGreaterThan(englishSection(html));
  });

  it('shows every sentence of the plain text in the HTML, the same code in both languages and the same link', () => {
    const html = message.htmlBody;
    const visible = htmlText(html);
    for (const line of message.textBody.split('\n').filter((l) => l !== '')) {
      // The code lines are split in the HTML: the label, then the code shown large.
      const label = line.endsWith(CODE) ? line.slice(0, -CODE.length).trimEnd() : line;
      expect(visible).toContain(label);
    }
    const arabic = html.slice(arabicSection(html), englishSection(html));
    const english = html.slice(englishSection(html));
    for (const part of [arabic, english]) {
      expect(part.match(/>(\d{6})<\/p>/)![1]).toBe(CODE);
      expect([...part.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([LINK, LINK]);
    }
    expect(html.match(/<a href=/g)).toHaveLength(4); // a button and a copyable link per language
  });

  it('has no external resources, scripts or tracking: the only URL is the sign-in link', () => {
    const html = message.htmlBody;
    expect(html).not.toMatch(/<(img|script|link|iframe|object|embed|form)\b/i);
    expect(html).not.toMatch(/\bsrc=/i);
    expect(new Set(html.match(/https?:\/\/[^"<\s]+/g))).toEqual(new Set([LINK]));
  });

  it('uses the configured code lifetime in both languages, and nothing else changes it', () => {
    const custom = buildMessage(settings({ TRAINEE_CODE_LIFETIME_MINUTES: '20' }), 'a@b.example', TOKEN, CODE);
    for (const part of [custom.textBody, htmlText(custom.htmlBody)]) {
      expect(part).toContain('صالحان لمدة 20 دقيقة');
      expect(part).toContain('valid for 20 minutes');
    }
  });

  it('without an absolute http(s) base URL, shows the link as text and makes no clickable link (as before, it still sends)', () => {
    const relative = buildMessage(settings({ TRAINEE_SIGN_IN_LINK_BASE_URL: '' }), 'a@b.example', TOKEN, CODE);
    expect(relative.htmlBody).not.toContain('<a ');
    expect(htmlText(relative.htmlBody)).toContain(`/sign-in/verify?token=${TOKEN}`);
    expect(relative.textBody).toContain(`/sign-in/verify?token=${TOKEN}`);
  });
});

describe('the HTML layout escapes every value', () => {
  const hostile = '<script>alert("x")</script> & \'quoted\'';
  const section = (url: string): EmailSection => ({
    heading: hostile,
    intro: [hostile],
    code: hostile,
    action: { lead: hostile, label: hostile, url },
    notes: [hostile],
  });

  it('escapes text, code, labels and the title', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    const html = renderBilingualHtml(hostile, section('https://ims.example/x'), section('https://ims.example/x'));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(`"x"`);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;');
  });

  it('never turns a javascript: or other non-http URL into a link, and escapes quotes inside an http URL', () => {
    const html = renderBilingualHtml('t', section('javascript:alert(1)'), section('https://ims.example/"><img/src=x>'));
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('javascript:alert(1)'); // shown as text only
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://ims.example/&quot;&gt;&lt;img/src=x&gt;"');
    // A URL with whitespace is not linked either.
    expect(renderBilingualHtml('t', section('https://a.example/ x'), section('https://a.example/ x'))).not.toContain(
      '<a ',
    );
  });
});

describe('the composed MIME message (real Nodemailer, in-memory transport, nothing sent)', () => {
  const SMTP: SmtpSettings = {
    host: 'smtp.gmail.com',
    port: 465,
    user: 'ims.sender@gmail.example',
    password: 'unique-app-password-7Q',
  };

  it('is From "ProGineer" at the configured address, multipart/alternative with text before HTML, in UTF-8', async () => {
    let raw = '';
    // Nodemailer's stream transport builds the exact message the SMTP transport would send, without a network.
    const factory: TransportFactory = () => {
      const transport = (nodemailer.createTransport as unknown as (o: object) => ReturnType<TransportFactory>)({
        streamTransport: true,
        buffer: true,
        newline: 'unix',
      });
      return {
        async sendMail(mail) {
          const info = (await transport.sendMail(mail)) as { message: Uint8Array };
          raw = new TextDecoder().decode(info.message);
          return {};
        },
        verify: async () => true as const,
        close: () => transport.close(),
      };
    };
    await smtpEmailSender(SMTP, factory).send(buildMessage(settings(), 'trainee@uni.example', TOKEN, CODE));

    expect(raw).toMatch(/^From: ProGineer <ims\.sender@gmail\.example>$/m);
    expect(raw).toMatch(/^To: trainee@uni\.example$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m); // the Arabic subject is encoded
    expect(raw).toMatch(/^Content-Type: multipart\/alternative;/m);
    const plain = raw.search(/^Content-Type: text\/plain; charset=utf-8$/m);
    const html = raw.search(/^Content-Type: text\/html; charset=utf-8$/m);
    expect(plain).toBeGreaterThan(0);
    expect(html).toBeGreaterThan(plain); // the last alternative is the preferred one: HTML
    expect(raw).not.toContain(SMTP.password);
  });
});

describe('sign-in still works from the HTML e-mail (regression)', () => {
  it('the code shown in the HTML signs the trainee in, once', async () => {
    const api = createTestApi();
    const email = uniqueEmail();
    expect((await api.client().post('/api/auth/trainee/request', { email })).status).toBe(202);
    const html = api.emails.lastTo(email).htmlBody;
    const code = html.match(/>(\d{6})<\/p>/)![1]!;
    expect(code).toBe(api.emails.lastSignInFor(email).code);

    const client = api.client();
    const response = await client.post('/api/auth/trainee/verify', { email, code });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ role: 'Trainee', email });
    expect((await api.client().post('/api/auth/trainee/verify', { email, code })).status).toBe(400);
    const stored = await withDb((db) =>
      db.query('SELECT used_at FROM trainee_sign_in_codes WHERE email = $1', [email]),
    );
    expect(stored.rows.map((r) => r.used_at !== null)).toEqual([true]);
  });
});
