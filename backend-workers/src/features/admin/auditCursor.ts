/**
 * The Load More cursor of the Admin audit log (owner decisions of 2026-11-22, option A): the audit log's own sequential
 * number never leaves the Worker, so the cursor carries it encrypted and authenticated.
 *
 * - `c1.` + base64url (unpadded) of IV (12 random bytes) ‖ AES-256-GCM ciphertext (25 bytes) ‖ tag (16 bytes): always
 *   53 bytes, so always 74 characters, whatever the number.
 * - Payload (fixed length): version byte 1, the audit number as 8 bytes big-endian, and the first 16 bytes of SHA-256
 *   of the filters it was issued for. Additional data: `ims.audit-cursor.v1|<Admin user id>`. A cursor is therefore
 *   only accepted for the same Admin and the same filters, and any change to it fails the GCM tag.
 * - Key: HKDF-SHA-256 from SESSION_SECRET with its own salt and info (independent of the session cookie's key). Issued
 *   with the current secret; read with the current or the previous one (SESSION_SECRET_PREVIOUS), like the cookie.
 * - No expiry: a cursor only ever selects entries older than a position, and the exclusions are applied by the query.
 *
 * Built-in Web Crypto only; no new secret, binding or dependency.
 */
export const AUDIT_CURSOR_LENGTH = 74;

const PREFIX = 'c1.';
const PAYLOAD_VERSION = 1;
const IV_LENGTH = 12;
const PAYLOAD_LENGTH = 25; // version (1) + audit number (8) + filter fingerprint (16)
const TAG_LENGTH = 16;
const BYTES = IV_LENGTH + PAYLOAD_LENGTH + TAG_LENGTH; // 53
const FORMAT = /^c1\.[A-Za-z0-9_-]{71}$/;
const MAX_ID = 2n ** 63n - 1n; // PostgreSQL bigint
const INFO = new TextEncoder().encode('ims.audit-cursor.v1');
const SALT = new TextEncoder().encode('ims.audit-cursor');

/** The validated filters of the request, each null when not set. */
export interface AuditCursorFilters {
  operation: string | null;
  table: string | null;
  actorType: string | null;
  actorId: string | null;
  from: string | null;
  to: string | null;
}

/** A cursor for the entries older than the audit entry `id` (a decimal string, as read from PostgreSQL). */
export async function issueAuditCursor(
  id: string,
  filters: AuditCursorFilters,
  userId: string,
  secret: string,
): Promise<string> {
  const payload = new Uint8Array(PAYLOAD_LENGTH);
  payload[0] = PAYLOAD_VERSION;
  new DataView(payload.buffer).setBigUint64(1, BigInt(id));
  payload.set(await fingerprint(filters), 9);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bound(userId) }, await keyFor(secret), payload),
  );
  const bytes = new Uint8Array(BYTES);
  bytes.set(iv);
  bytes.set(sealed, IV_LENGTH);
  return PREFIX + base64Url(bytes);
}

/** The audit number a cursor stands for, when it is authentic for this Admin and these filters; otherwise null. */
export async function readAuditCursor(
  value: string,
  filters: AuditCursorFilters,
  userId: string,
  secrets: string[],
): Promise<string | null> {
  if (!FORMAT.test(value)) return null;
  const encoded = value.slice(PREFIX.length);
  const bytes = fromBase64Url(encoded);
  // Exactly 53 bytes, spelled canonically (the last character's 2 unused bits zero): one spelling per cursor.
  if (bytes?.length !== BYTES || base64Url(bytes) !== encoded) return null;

  for (const secret of secrets) {
    let payload: Uint8Array;
    try {
      payload = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.slice(0, IV_LENGTH), additionalData: bound(userId) },
          await keyFor(secret),
          bytes.slice(IV_LENGTH),
        ),
      );
    } catch {
      continue; // not issued with this secret (or changed)
    }
    if (payload.length !== PAYLOAD_LENGTH || payload[0] !== PAYLOAD_VERSION) return null;
    const id = new DataView(payload.buffer).getBigUint64(1);
    if (id < 1n || id > MAX_ID) return null;
    const expected = await fingerprint(filters);
    return expected.every((b, i) => payload[9 + i] === b) ? id.toString() : null;
  }

  return null;
}

/** First 16 bytes of SHA-256 of the filters in a fixed order (encrypted inside the cursor, never shown). */
async function fingerprint(f: AuditCursorFilters): Promise<Uint8Array> {
  const canonical = JSON.stringify([f.operation, f.table, f.actorType, f.actorId, f.from, f.to]);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).slice(0, 16);
}

function bound(userId: string): Uint8Array {
  return new TextEncoder().encode(`ims.audit-cursor.v1|${userId.toLowerCase()}`);
}

// CryptoKeys are not I/O objects, so they can be cached across requests within an isolate (as for the session key).
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, [
        'deriveKey',
      ]);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO },
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

function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(text, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
