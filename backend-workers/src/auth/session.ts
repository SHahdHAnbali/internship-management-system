import { isUserRole, type UserRole } from '../domain/roles';

/**
 * The HttpOnly session cookie (AD-12, AD-40, policy AD-44):
 * - name `ims.session`, `path=/; samesite=strict; httponly`, plus `secure` outside development (and over HTTPS in
 *   development), and `expires`/`max-age` set to the ticket's expiry, so it survives browser restarts;
 * - the ticket (session id, user id, role, issued, expires, absolute end) is encrypted and authenticated with
 *   AES-256-GCM using a key derived from SESSION_SECRET (HKDF-SHA-256); the browser cannot read or change it;
 * - idle expiry: the ticket lives SESSION_IDLE_TIMEOUT_MINUTES (7 days) and is re-issued while it is used (at most
 *   once an hour), but never past the session's absolute end (SESSION_ABSOLUTE_LIFETIME_MINUTES, 30 days);
 * - the session it names is a `user_sessions` row, checked on every request: sign-out revokes it server-side.
 * Staff and trainee accounts and their roles are re-read from PostgreSQL on every request (see app.ts), so the role
 * in the ticket is only used to know which table holds the account. An ordinary Google user (role null) has no account
 * record: their verified Google e-mail and name travel in the ticket, and they hold no permissions.
 */
export const SESSION_COOKIE = 'ims.session';
const VERSION = 'v1';
const ADDITIONAL_DATA = new TextEncoder().encode('ims.session.v1');

export interface SessionTicket {
  /** Employee or trainee id; `google:<subject>` for an ordinary Google user. */
  sub: string;
  /** null: an ordinary (non-staff) Google user, who has no database record and no role. */
  role: UserRole | null;
  /** Only for an ordinary Google user: the verified e-mail and name from Google (there is no record to re-read). */
  email?: string;
  name?: string | null;
  /** Issued and expires (idle), Unix milliseconds. */
  iat: number;
  exp: number;
  /**
   * The `user_sessions` row and its absolute end (Unix milliseconds). Absent only in tickets issued before AD-44, which
   * are accepted until their own (8-hour) expiry and then moved to a new session row (see app.ts).
   */
  sid?: string;
  aexp?: number;
}

/** A `user_sessions` row: its id and absolute end. */
export interface SessionRecord {
  id: string;
  expiresAt: Date;
}

/** The longest a used ticket goes without being re-issued, so the idle timeout counts from the last activity. */
const MAX_RENEWAL_INTERVAL_MS = 60 * 60_000;

/** A ticket for `session`: valid for the idle timeout from now, but never past the session's absolute end. */
export function newTicket(
  user: { id: string; role: UserRole | null; email: string; name: string | null },
  session: SessionRecord,
  now: Date,
  idleTimeoutMinutes: number,
): SessionTicket {
  const iat = now.getTime();
  const aexp = session.expiresAt.getTime();
  const profile = user.role === null ? { email: user.email, name: user.name } : {};
  return {
    sub: user.id,
    role: user.role,
    ...profile,
    iat,
    exp: Math.min(iat + idleTimeoutMinutes * 60_000, aexp),
    sid: session.id,
    aexp,
  };
}

/**
 * Re-issue a used ticket once it is an hour old (or half the idle timeout, if shorter), so the idle timeout counts from
 * the last activity. A ticket that already ends at the session's absolute end cannot be extended.
 */
export function needsRenewal(ticket: SessionTicket, now: Date, idleTimeoutMinutes: number): boolean {
  if (ticket.aexp !== undefined && ticket.exp >= ticket.aexp) return false;
  return now.getTime() - ticket.iat >= Math.min(MAX_RENEWAL_INTERVAL_MS, (idleTimeoutMinutes * 60_000) / 2);
}

export async function protectTicket(ticket: SessionTicket, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(ticket));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ADDITIONAL_DATA },
    await keyFor(secret),
    plaintext,
  );
  return `${VERSION}.${base64Url(concat(iv, new Uint8Array(ciphertext)))}`;
}

/** The ticket when the cookie is authentic (any of `secrets`) and not expired; otherwise null. */
export async function unprotectTicket(value: string, secrets: string[], now: Date): Promise<SessionTicket | null> {
  const [version, payload, ...rest] = value.split('.');
  if (version !== VERSION || !payload || rest.length > 0) return null;

  const data = fromBase64Url(payload);
  if (!data || data.length < 12 + 16) return null;

  for (const secret of secrets) {
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: data.slice(0, 12), additionalData: ADDITIONAL_DATA },
        await keyFor(secret),
        data.slice(12),
      );
      const ticket = parseTicket(new TextDecoder().decode(plaintext));
      return ticket && now.getTime() < ticket.exp ? ticket : null;
    } catch {
      // not encrypted with this secret
    }
  }

  return null;
}

/** A persistent cookie that the browser keeps until the ticket expires (`max-age`, and `expires` for old browsers). */
export function sessionCookie(value: string, ticket: SessionTicket, now: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((ticket.exp - now.getTime()) / 1000));
  const expires = new Date(ticket.exp).toUTCString();
  return `${SESSION_COOKIE}=${value}; expires=${expires}; max-age=${maxAge}; path=/;${secure ? ' secure;' : ''} samesite=strict; httponly`;
}

export function expiredSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;${secure ? ' secure;' : ''} samesite=strict; httponly`;
}

function parseTicket(text: string): SessionTicket | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { sub, role, email, name, iat, exp, sid, aexp } = value as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return null;
    // A session reference has both parts, or neither (a ticket from before AD-44).
    if ((sid === undefined) !== (aexp === undefined)) return null;
    if (sid !== undefined && (typeof sid !== 'string' || typeof aexp !== 'number' || exp > aexp)) return null;
    const session = sid === undefined ? {} : { sid: sid as string, aexp: aexp as number };
    if (typeof role === 'string' && isUserRole(role)) return { sub, role, iat, exp, ...session };
    // An ordinary Google user: no role, identity carried in the (encrypted, authenticated) ticket.
    return role === null &&
      sub.startsWith('google:') &&
      typeof email === 'string' &&
      (typeof name === 'string' || name === null)
      ? { sub, role: null, email, name, iat, exp, ...session }
      : null;
  } catch {
    return null;
  }
}

// CryptoKeys are not I/O objects, so they can be cached across requests within an isolate.
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ims.session'), info: ADDITIONAL_DATA },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keys.set(secret, key);
  }

  return key;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
