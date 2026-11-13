// AD-65 one-time catch-up: sends the incoming-mentor e-mail ("TrainingTransferredToYou") of ONE transfer that was
// executed before that e-mail existed. Same template, sender (ProGineer, Gmail SMTP, AD-58) and content as the Worker's
// e-mail. It never writes to the database (READ ONLY transaction, rolled back) and never re-executes anything.
//
// Safety:
// - one exact transfer id (`assignment_transfers.id`); refused unless that transfer is executed;
// - `--expect` must equal the masked address of its incoming mentor (confirmed by the operator after a dry run);
// - dry run by default; `--check-smtp` (dry run) only logs in to the SMTP server, sending nothing;
// - `--send` sends once and only if the `--record` file does not exist yet: the record is created (exclusively) with
//   status SENDING before the attempt, so a second run, or a run after an interrupted one, refuses instead of resending;
// - the outcome comes from the SMTP server's answer only, never from the record: ACCEPTED (250 with the recipient
//   accepted), FAILED (an explicit refusal) or UNKNOWN (timeout, dropped connection, unexpected answer: it may have been
//   accepted, so check manually; never resend automatically). A record left at SENDING is also UNKNOWN;
// - no automatic retry. Acceptance by the SMTP server is not delivery to the inbox;
// - secrets are read from the environment and `.dev.vars` (normalized like the Worker secrets set from it on
//   2026-11-10: surrounding quotes removed, spaces removed from the App Password) and never printed.
//
// Usage (from backend-workers/, Node 22):
//   node_modules/.bin/esbuild scripts/transfer-email-catch-up.ts --bundle --platform=node --format=esm \
//     --packages=external --outfile=node_modules/.cache/ims-ops/transfer-email-catch-up.mjs
//   CATCH_UP_DATABASE="<Npgsql or postgres connection string, read-only role>" \
//     node node_modules/.cache/ims-ops/transfer-email-catch-up.mjs --transfer <id> --expect <masked address> \
//     --site https://progineer-ims.pages.dev --record <private record file> [--check-smtp | --send]
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import nodemailer from 'nodemailer';
import { EMAIL_SENDER_NAME, smtpTransportOptions } from '../src/email';
import {
  CatchUpRefused,
  classifySmtpOutcome,
  maskEmail,
  prepareTransferCatchUpEmail,
} from '../src/features/notifications/transferEmailCatchUp';

const ALLOWED = new Set(['transfer', 'expect', 'site', 'record', 'send', 'check-smtp', 'dev-vars']);
const FLAGS = new Set(['send', 'check-smtp']);

function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith('--') || !ALLOWED.has(key.slice(2))) throw new CatchUpRefused(`Unknown argument: ${key}`);
    const name = key.slice(2);
    if (FLAGS.has(name)) args[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new CatchUpRefused(`--${name} needs a value`);
      args[name] = value;
    }
  }
  return args;
}

/** A postgres URL, or the Npgsql form kept in the .NET user-secrets (`Host=…;Username=…;Password=…`). */
function databaseConfig(value: string): pg.ClientConfig {
  if (/^postgres(ql)?:\/\//.test(value)) return { connectionString: value, ssl: { rejectUnauthorized: true } };
  const parts = Object.fromEntries(
    value
      .split(';')
      .filter((p) => p.includes('='))
      .map((p) => [p.slice(0, p.indexOf('=')).trim().toLowerCase().replace(/\s/g, ''), p.slice(p.indexOf('=') + 1)]),
  );
  const host = parts.host ?? parts.server;
  if (!host) throw new CatchUpRefused('CATCH_UP_DATABASE has no host.');
  return {
    host,
    port: Number(parts.port ?? 5432),
    database: parts.database,
    user: parts.username ?? parts.userid ?? parts.user,
    password: parts.password,
    // TLS with a verified certificate, unless the string itself disables it (the local Docker database only).
    ssl: parts.sslmode?.toLowerCase() === 'disable' ? false : { rejectUnauthorized: true, servername: host },
  };
}

const unquote = (v: string) =>
  v.length > 1 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0] ? v.slice(1, -1) : v;

/** SMTP settings from `.dev.vars` (KEY=value lines); values never printed. */
function smtpSettings(path: string) {
  const vars = Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), unquote(l.slice(l.indexOf('=') + 1).trim())]),
  );
  const { SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user } = vars;
  const password = vars.SMTP_APP_PASSWORD?.replace(/\s/g, '');
  if (!host || !user || !password || port !== '465') {
    throw new CatchUpRefused(`${path} must set SMTP_HOST, SMTP_PORT=465, SMTP_USER and SMTP_APP_PASSWORD.`);
  }
  return { host, port: 465 as const, user, password };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['transfer', 'expect', 'site', 'record']) {
    if (typeof args[required] !== 'string') throw new CatchUpRefused(`--${required} is required`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.transfer as string)) {
    throw new CatchUpRefused('--transfer must be one exact transfer id (a lower-case UUID).');
  }
  const database = process.env.CATCH_UP_DATABASE;
  if (!database) throw new CatchUpRefused('CATCH_UP_DATABASE is not set.');

  const client = new pg.Client(databaseConfig(database));
  await client.connect();
  let prepared: Awaited<ReturnType<typeof prepareTransferCatchUpEmail>>;
  try {
    await client.query('BEGIN READ ONLY');
    prepared = await prepareTransferCatchUpEmail(client, {
      transferId: args.transfer as string,
      expectedMaskedRecipient: args.expect as string,
      siteBaseUrl: args.site as string,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }

  const { event, message, maskedRecipient } = prepared;
  const content = event.content.kind === 'TrainingTransferredToYou' ? event.content : null;
  const summary = {
    transferId: event.entityId,
    kind: event.content.kind,
    recipient: maskedRecipient,
    subject: message.subject,
    field: content?.field,
    effectiveDate: content?.effectiveDate,
    plannedEndDate: content?.plannedEndDate,
  };
  if (args.send === true && args['check-smtp'] === true)
    throw new CatchUpRefused('Use --check-smtp or --send, not both.');
  const smtp = () => smtpSettings(typeof args['dev-vars'] === 'string' ? args['dev-vars'] : '.dev.vars');
  if (args.send !== true) {
    let smtpCheck: string | undefined;
    if (args['check-smtp'] === true) {
      const settings = smtp();
      const transport = nodemailer.createTransport(smtpTransportOptions(settings));
      try {
        await transport.verify(); // connects and authenticates; sends nothing
        smtpCheck = `login OK as ${maskEmail(settings.user)} (${settings.host}:${settings.port})`;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        smtpCheck = `login FAILED (${typeof code === 'string' ? code : 'unknown'})`;
        process.exitCode = 1;
      } finally {
        transport.close();
      }
    }
    console.log(JSON.stringify({ mode: 'dry-run (nothing sent)', ...summary, smtpCheck }, null, 2));
    return;
  }

  const settings = smtp();
  const record = args.record as string;
  const base = { ...summary, sender: `${EMAIL_SENDER_NAME} <${maskEmail(settings.user)}>` };
  // Created exclusively before the attempt: if it exists, this transfer's catch-up was already attempted.
  try {
    writeFileSync(
      record,
      JSON.stringify({ ...base, status: 'SENDING', startedAt: new Date().toISOString() }, null, 2),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  } catch {
    throw new CatchUpRefused(`The record ${record} already exists: not sending again.`);
  }

  // One attempt, with the Worker's own transport settings and sender; the outcome is the server's answer only.
  const transport = nodemailer.createTransport(smtpTransportOptions(settings));
  let attempt: Parameters<typeof classifySmtpOutcome>[0];
  try {
    const info = await transport.sendMail({
      from: { name: EMAIL_SENDER_NAME, address: settings.user },
      to: message.to,
      subject: message.subject,
      text: message.textBody,
      html: message.htmlBody,
    });
    attempt = { ok: true, info };
  } catch (error) {
    attempt = { ok: false, error };
  } finally {
    transport.close();
  }
  const status = classifySmtpOutcome(attempt, message.to);
  const detail = attempt.ok
    ? {
        smtpResponse: (attempt.info.response ?? '').slice(0, 3) || null,
        accepted: (attempt.info.accepted ?? []).length,
        rejected: (attempt.info.rejected ?? []).length,
        messageId: attempt.info.messageId ?? null,
      }
    : {
        errorCode: String((attempt.error as { code?: unknown } | null)?.code ?? 'unknown'),
        smtpResponse: String((attempt.error as { responseCode?: unknown } | null)?.responseCode ?? '') || null,
      };
  const result = { ...base, status, ...detail, finishedAt: new Date().toISOString() };
  console.log(JSON.stringify(result, null, 2)); // printed first, in case the record cannot be rewritten
  writeFileSync(record, JSON.stringify(result, null, 2), { mode: 0o600 });
  process.exitCode = status === 'ACCEPTED' ? 0 : status === 'FAILED' ? 1 : 3;
}

main().catch((error: unknown) => {
  // Never the error text (it may hold a host or user name): its kind and code only.
  const code = (error as { code?: unknown } | null)?.code;
  console.error(
    error instanceof CatchUpRefused
      ? `Refused: ${error.message}`
      : `Failed: ${(error as Error).name}${typeof code === 'string' ? ` (${code})` : ''}`,
  );
  process.exitCode = 2;
});
