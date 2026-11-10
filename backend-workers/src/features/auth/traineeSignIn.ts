import type { Settings } from '../../config';
import type { SessionUser } from '../../context';
import { updateOrConflict, type AuditActor, type Database } from '../../db';
import { normalizeEmail } from '../../domain/emailAddress';
import { trimDotnet } from '../../domain/text';
import { assertUsable, expiryFor, isUsable, type TraineeSignInCode } from '../../domain/traineeSignInCode';
import { uuidV7 } from '../../domain/uuid';
import type { EmailMessage, EmailSender } from '../../email';
import { renderBilingualHtml } from '../../emailTemplate';
import { base64Url } from '../../auth/session';

/**
 * Passwordless trainee registration and sign-in (PDF §2, §4, §9): a one-time link and code are e-mailed, valid for
 * 15 minutes and usable once. The trainee account is created on the first successful verification.
 * Mirrors Ims.Application.Auth.TraineeSignIn, including the hash formats, so codes issued by either API verify in both.
 */
export interface TraineeSignInContext {
  db: Database;
  actor: AuditActor;
  settings: Settings;
  email: EmailSender;
  now: Date;
}

const CODE_DIGITS = 6;

const CODE_COLUMNS =
  'id, email, token_hash, code_hash, issued_at, expires_at, used_at, superseded_at, failed_attempts, xmin::text AS version';

interface CodeRow {
  id: string;
  email: string;
  token_hash: string;
  code_hash: string;
  issued_at: Date;
  expires_at: Date;
  used_at: Date | null;
  superseded_at: Date | null;
  failed_attempts: number;
  version: string;
}

/**
 * E-mails a new link and code and invalidates earlier ones. The response is the same whether or not the e-mail
 * belongs to an existing trainee, so the endpoint cannot be used to discover accounts.
 */
export async function requestCode(emailAddress: string, context: TraineeSignInContext): Promise<void> {
  const { db, actor, settings, now } = context;
  const address = normalizeEmail(emailAddress);

  const { rows: open } = await db.query<{ id: string; version: string }>(
    `SELECT id, xmin::text AS version FROM trainee_sign_in_codes
      WHERE email = $1 AND used_at IS NULL AND superseded_at IS NULL AND expires_at > $2`,
    [address, now.toISOString()],
  );

  const id = uuidV7(now);
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const code = randomCode();
  const expiresAt = expiryFor(now, settings.trainee.codeLifetimeMinutes);
  const [tokenHash, codeHash] = await Promise.all([sha256Hex(token), hashCode(id, code)]);

  // Send before saving: if delivery fails, the trainee's earlier code stays valid and no undelivered code is stored.
  await context.email.send(buildMessage(settings, address, token, code));

  await db.transaction(actor, async (tx) => {
    for (const row of open) {
      await updateOrConflict(
        tx,
        'UPDATE trainee_sign_in_codes SET superseded_at = $1 WHERE id = $2 AND xmin = $3::xid',
        [now.toISOString(), row.id, row.version],
      );
    }

    await tx.query(
      `INSERT INTO trainee_sign_in_codes
         (id, email, token_hash, code_hash, issued_at, expires_at, used_at, superseded_at, failed_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, 0)`,
      [id, address, tokenHash, codeHash, now.toISOString(), expiresAt.toISOString()],
    );
  });
}

/** Verifies an e-mail + code pair. Wrong codes count towards the attempt limit. */
export async function verifyCode(
  emailAddress: string,
  code: string,
  context: TraineeSignInContext,
): Promise<SessionUser | null> {
  const { db, actor, now } = context;
  const address = normalizeEmail(emailAddress);
  const { rows } = await db.query<CodeRow>(
    `SELECT ${CODE_COLUMNS} FROM trainee_sign_in_codes
      WHERE email = $1 AND used_at IS NULL AND superseded_at IS NULL
      ORDER BY issued_at DESC LIMIT 1`,
    [address],
  );
  const latest = rows[0] && toCode(rows[0]);
  if (!latest || !isUsable(latest, now)) {
    return null;
  }

  if (!fixedTimeEquals(await hashCode(latest.id, trimDotnet(code)), latest.codeHash)) {
    await db.transaction(actor, (tx) =>
      updateOrConflict(tx, 'UPDATE trainee_sign_in_codes SET failed_attempts = $1 WHERE id = $2 AND xmin = $3::xid', [
        latest.failedAttempts + 1,
        latest.id,
        latest.version,
      ]),
    );
    return null;
  }

  return complete(latest, context);
}

/** Verifies the secret from the e-mailed link. */
export async function verifyToken(token: string, context: TraineeSignInContext): Promise<SessionUser | null> {
  const hash = await sha256Hex(trimDotnet(token));
  const { rows } = await context.db.query<CodeRow>(
    `SELECT ${CODE_COLUMNS} FROM trainee_sign_in_codes WHERE token_hash = $1`,
    [hash],
  );
  const signInCode = rows[0] && toCode(rows[0]);
  return signInCode && isUsable(signInCode, context.now) ? complete(signInCode, context) : null;
}

async function complete(signInCode: TraineeSignInCode, context: TraineeSignInContext): Promise<SessionUser> {
  const { db, now } = context;
  assertUsable(signInCode, now);
  const { rows } = await db.query<{ id: string; email: string }>('SELECT id, email FROM trainees WHERE email = $1', [
    signInCode.email,
  ]);
  const trainee = rows[0] ?? { id: uuidV7(now), email: normalizeEmail(signInCode.email) };

  // The code or link has been verified: using it (and creating the account on a first sign-in) is recorded as the
  // trainee. Requests and wrong codes, before any verification, stay with the request's actor (Anonymous).
  await db.transaction({ type: 'Trainee', id: trainee.id }, async (tx) => {
    await updateOrConflict(tx, 'UPDATE trainee_sign_in_codes SET used_at = $1 WHERE id = $2 AND xmin = $3::xid', [
      now.toISOString(),
      signInCode.id,
      signInCode.version,
    ]);
    if (!rows[0]) {
      await tx.query('INSERT INTO trainees (id, email) VALUES ($1, $2)', [trainee.id, trainee.email]);
    }
  });

  return { id: trainee.id, role: 'Trainee', email: trainee.email, name: null };
}

export function buildMessage(settings: Settings, to: string, token: string, code: string): EmailMessage {
  const link = `${settings.trainee.signInLinkBaseUrl.replace(/\/+$/, '')}/sign-in/verify?token=${token}`;
  const minutes = settings.trainee.codeLifetimeMinutes;
  // PDF §7: templates in Arabic and English; AD-60: one message, Arabic first, HTML with an equivalent plain text.
  // The plain text is the same as the C# API's; the HTML shows the same sentences.
  const ar = {
    codeLabel: 'رمز الدخول إلى نظام إدارة المتدربين:',
    link: 'أو افتح هذا الرابط لتسجيل الدخول مباشرة:',
    validity: `الرمز والرابط صالحان لمدة ${minutes} دقيقة ولمرة واحدة فقط. إذا لم تطلب ذلك فتجاهل هذه الرسالة.`,
  };
  const en = {
    codeLabel: 'Your Trainee Management System sign-in code:',
    link: 'Or open this link to sign in directly:',
    validity: `The code and link are valid for ${minutes} minutes and can be used once. If you did not request this, ignore this e-mail.`,
  };
  const body = [
    `${ar.codeLabel} ${code}`,
    ar.link,
    link,
    ar.validity,
    '',
    `${en.codeLabel} ${code}`,
    en.link,
    link,
    en.validity,
  ].join('\n');
  const subject = `رمز الدخول / Sign-in code: ${code}`;
  const html = renderBilingualHtml(
    subject,
    {
      heading: 'رمز الدخول',
      intro: [ar.codeLabel],
      code,
      action: { lead: ar.link, label: 'تسجيل الدخول', url: link },
      notes: [ar.validity],
    },
    {
      heading: 'Sign-in code',
      intro: [en.codeLabel],
      code,
      action: { lead: en.link, label: 'Sign in', url: link },
      notes: [en.validity],
    },
  );
  return { to, subject, textBody: body, htmlBody: html };
}

/** A uniformly random 6-digit code (RandomNumberGenerator.GetInt32(0, 10^6)), zero-padded. */
function randomCode(): string {
  const range = 10 ** CODE_DIGITS;
  const limit = Math.floor(2 ** 32 / range) * range; // reject the biased tail
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    value = crypto.getRandomValues(buffer)[0]!;
  } while (value >= limit);
  return String(value % range).padStart(CODE_DIGITS, '0');
}

/** Upper-case hex SHA-256 of the UTF-8 text (C# `Convert.ToHexString(SHA256.HashData(...))`). */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Hash of the code bound to its record: SHA-256 of `{id:N}:{code}` (id as 32 hex digits). */
function hashCode(id: string, code: string): Promise<string> {
  return sha256Hex(`${id.replace(/-/g, '').toLowerCase()}:${code}`);
}

/** Constant-time comparison (CryptographicOperations.FixedTimeEquals); different lengths are unequal. */
function fixedTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function toCode(row: CodeRow): TraineeSignInCode {
  return {
    id: row.id,
    email: row.email,
    tokenHash: row.token_hash,
    codeHash: row.code_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    supersededAt: row.superseded_at,
    failedAttempts: row.failed_attempts,
    version: row.version,
  };
}
