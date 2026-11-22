import { describe, expect, it } from 'vitest';
import {
  AUDIT_CURSOR_LENGTH,
  type AuditCursorFilters,
  issueAuditCursor,
  readAuditCursor,
} from '../src/features/admin/auditCursor';

/**
 * The Admin audit log's Load More cursor (owner decisions of 2026-11-22, option A): the audit number stays inside the
 * Worker. A cursor is AES-256-GCM encrypted and authenticated with a key derived from SESSION_SECRET (HKDF, its own
 * salt and info), bound to the Admin and to the filters it was issued for; anything else is refused.
 */
const SECRET = 'test-session-secret-0123456789abcdef0123456789';
const OTHER_SECRET = 'another-session-secret-0123456789abcdef0123';
const ADMIN = '01a1aaaa-0000-7000-8000-000000000001';
const OTHER_ADMIN = '01a1aaaa-0000-7000-8000-000000000002';
const FILTERS: AuditCursorFilters = {
  operation: 'UPDATE',
  table: 'fields',
  actorType: 'Staff',
  actorId: ADMIN,
  from: '2026-11-01T00:00:00.000Z',
  to: null,
};
const NONE: AuditCursorFilters = { operation: null, table: null, actorType: null, actorId: null, from: null, to: null };
// Distinctive, so a chance match in random bytes is practically impossible.
const ID = '98765432123';

const decode = (cursor: string) => {
  const text = atob(cursor.slice(3).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
};
const encode = (bytes: Uint8Array) =>
  `c1.${btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
const contains = (haystack: Uint8Array, needle: Uint8Array) =>
  haystack.some((_, i) => needle.every((b, j) => haystack[i + j] === b));
const bigEndian = (id: string) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(id));
  return bytes;
};

describe('audit log cursor: format', () => {
  it('is exactly 74 characters: "c1." and the unpadded base64url of IV (12) + payload (25) + tag (16) = 53 bytes', async () => {
    const cursor = await issueAuditCursor(ID, FILTERS, ADMIN, SECRET);

    expect(AUDIT_CURSOR_LENGTH).toBe(74);
    expect(cursor).toHaveLength(74);
    expect(cursor).toMatch(/^c1\.[A-Za-z0-9_-]{71}$/);
    expect(decode(cursor)).toHaveLength(53);
  });

  it('has the same length whatever the audit number, so its length reveals nothing', async () => {
    for (const id of ['1', '99', '100', '101', ID, '9223372036854775807']) {
      expect(await issueAuditCursor(id, NONE, ADMIN, SECRET), id).toHaveLength(74);
    }
  });

  it('does not contain the audit number in any readable form, even after base64 decoding', async () => {
    const cursor = await issueAuditCursor(ID, FILTERS, ADMIN, SECRET);
    const bytes = decode(cursor);
    const hex = BigInt(ID).toString(16);

    expect(cursor).not.toContain(ID);
    expect(cursor.toLowerCase()).not.toContain(hex);
    expect(contains(bytes, new TextEncoder().encode(ID))).toBe(false);
    expect(contains(bytes, new TextEncoder().encode(hex))).toBe(false);
    expect(contains(bytes, bigEndian(ID))).toBe(false);
    expect(contains(bytes, bigEndian(ID).reverse())).toBe(false);
    // Nor in plain base64 of the decimal number.
    expect(cursor).not.toContain(btoa(ID).replace(/=+$/, ''));
  });

  it('is different every time, even for the same position (random IV)', async () => {
    const cursors = await Promise.all(Array.from({ length: 5 }, () => issueAuditCursor(ID, FILTERS, ADMIN, SECRET)));
    expect(new Set(cursors).size).toBe(5);
  });
});

describe('audit log cursor: reading', () => {
  it('gives back the audit number for the same Admin and filters', async () => {
    for (const id of ['1', '99', '100', ID, '9223372036854775807']) {
      const cursor = await issueAuditCursor(id, FILTERS, ADMIN, SECRET);
      expect(await readAuditCursor(cursor, FILTERS, ADMIN, [SECRET]), id).toBe(id);
    }
  });

  it('refuses another Admin, other filters and another secret', async () => {
    const cursor = await issueAuditCursor(ID, FILTERS, ADMIN, SECRET);

    expect(await readAuditCursor(cursor, FILTERS, OTHER_ADMIN, [SECRET])).toBeNull();
    expect(await readAuditCursor(cursor, NONE, ADMIN, [SECRET])).toBeNull();
    for (const changed of [
      { operation: 'INSERT' },
      { table: 'trainees' },
      { actorType: 'System' },
      { actorId: OTHER_ADMIN },
      { from: '2026-11-01T00:00:00.001Z' },
      { to: '2026-12-01T00:00:00.000Z' },
    ]) {
      expect(
        await readAuditCursor(cursor, { ...FILTERS, ...changed }, ADMIN, [SECRET]),
        JSON.stringify(changed),
      ).toBeNull();
    }
    expect(await readAuditCursor(cursor, FILTERS, ADMIN, [OTHER_SECRET])).toBeNull();
  });

  it('keeps working through a SESSION_SECRET rotation while the old secret is the previous one', async () => {
    const cursor = await issueAuditCursor(ID, FILTERS, ADMIN, SECRET);

    expect(await readAuditCursor(cursor, FILTERS, ADMIN, [OTHER_SECRET, SECRET])).toBe(ID);
    expect(await readAuditCursor(cursor, FILTERS, ADMIN, [OTHER_SECRET])).toBeNull();
  });

  it('refuses any changed byte of the IV, the encrypted payload or the tag', async () => {
    const bytes = decode(await issueAuditCursor(ID, FILTERS, ADMIN, SECRET));
    for (let i = 0; i < bytes.length; i++) {
      const tampered = bytes.slice();
      tampered[i]! ^= 0x01;
      expect(await readAuditCursor(encode(tampered), FILTERS, ADMIN, [SECRET]), `byte ${i}`).toBeNull();
    }
  });

  it('accepts only the canonical spelling: the 2 unused bits of the last character must be zero', async () => {
    const valid = await issueAuditCursor(ID, FILTERS, ADMIN, SECRET);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(valid.at(-1)!);
    for (const bits of [1, 2, 3]) {
      const sibling = valid.slice(0, -1) + alphabet[last | bits]!;
      expect(await readAuditCursor(sibling, FILTERS, ADMIN, [SECRET]), sibling).toBeNull();
    }
  });

  it('refuses malformed values, and plain (unencrypted) encodings of an audit number', async () => {
    const valid = await issueAuditCursor(ID, FILTERS, ADMIN, SECRET);
    const zeroes = encode(new Uint8Array(53));
    const plain = new Uint8Array(53);
    plain.set(new TextEncoder().encode(ID));
    for (const value of [
      '',
      ID,
      'c1.',
      valid.slice(0, 73),
      `${valid}A`,
      `${valid.slice(0, 73)}=`,
      `c2.${valid.slice(3)}`,
      `C1.${valid.slice(3)}`,
      `${valid.slice(0, 10)}+${valid.slice(11)}`,
      `${valid.slice(0, 10)}/${valid.slice(11)}`,
      ` ${valid.slice(1)}`,
      zeroes,
      encode(plain),
      `c1.${btoa(ID)}`,
      'c1.' + 'A'.repeat(71),
    ]) {
      expect(await readAuditCursor(value, FILTERS, ADMIN, [SECRET]), value).toBeNull();
    }
  });
});
