import { DomainError } from './errors';
import { required } from './guard';
import { toLowerInvariant } from './text';

/** Mirrors Ims.Domain.Common.EmailAddress: trimmed, lower-cased, and a valid address. */
export const EMAIL_MAX_LENGTH = 320;

export function normalizeEmail(value: string | null | undefined): string {
  const email = toLowerInvariant(required(value, 'Email', EMAIL_MAX_LENGTH));
  if (!isMailAddress(email)) {
    throw new DomainError('validation.email', 'Email is not a valid address.');
  }

  return email;
}

const FAIL = -2;

/**
 * True when .NET accepts `value` as a mail address *and* its normalised `Address` equals the input, i.e. the C# check
 * `MailAddress.TryCreate(email, out var parsed) && parsed.Address == email`. Display names, comments and white space
 * around the parts change `Address`, so what remains is `local@domain`, parsed right to left like .NET's
 * System.Net.Mail readers (DotAtomReader, QuotedStringFormatReader, DomainLiteralReader, QuotedPairReader,
 * WhitespaceReader). Verified against the real .NET implementation with test/fixtures/email-corpus.json.
 */
export function isMailAddress(value: string): boolean {
  let index = value.length - 1;
  if (index < 0) return false;

  index = value[index] === ']' ? readDomainLiteralReverse(value, index) : readDotAtomReverse(value, index);
  if (index < 0 || value[index] !== '@') return false;

  index--;
  if (index < 0) return false;

  index = value[index] === '"' ? readQuotedStringReverse(value, index) : readDotAtomReverse(value, index);
  return index === -1;
}

/**
 * Reads a dot-atom ending at `index`; returns the index before it or FAIL. Any non-ASCII character is accepted.
 * Leading and doubled dots are rejected; a trailing dot is accepted (as .NET does).
 */
function readDotAtomReverse(value: string, index: number): number {
  const start = index;
  while (index >= 0 && (value.charCodeAt(index) > 0x7f || value[index] === '.' || isAsciiAtext(value[index]!))) {
    index--;
  }

  const atom = value.slice(index + 1, start + 1);
  if (atom.length === 0 || atom.startsWith('.') || atom.includes('..')) return FAIL;
  return index;
}

/** Reads a quoted string whose closing quote is at `index`; returns the index before the opening quote or FAIL. */
function readQuotedStringReverse(value: string, index: number): number {
  index--; // the closing quote
  for (;;) {
    index = readFoldingWhiteSpaceReverse(value, index);
    if (index < 0) return FAIL; // FAIL, or no opening quote

    const quoted = countQuotedChars(value, index, true);
    if (quoted === FAIL) return FAIL;
    if (quoted > 0) {
      index -= quoted;
    } else if (value[index] === '"') {
      return index - 1;
    } else if (!isQtext(value.charCodeAt(index))) {
      return FAIL;
    } else {
      index--;
    }
  }
}

/** Reads `[…]` whose closing bracket is at `index`; returns the index before the opening bracket or FAIL. */
function readDomainLiteralReverse(value: string, index: number): number {
  index--; // the closing bracket
  for (;;) {
    index = readFoldingWhiteSpaceReverse(value, index);
    if (index < 0) return FAIL;

    const quoted = countQuotedChars(value, index, false);
    if (quoted === FAIL) return FAIL;
    if (quoted > 0) {
      index -= quoted;
    } else if (value[index] === '[') {
      return index - 1;
    } else if (!isDtext(value.charCodeAt(index))) {
      return FAIL;
    } else {
      index--;
    }
  }
}

/**
 * When the character at `index` is escaped by an odd run of backslashes, returns 2 (the character and its backslash);
 * otherwise 0. Escaping a non-ASCII character is invalid where Unicode is not permitted (domain literals).
 */
function countQuotedChars(value: string, index: number, permitUnicode: boolean): number {
  if (index <= 0 || value[index - 1] !== '\\') return 0;

  let backslashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++;
  if (backslashes % 2 === 0) return 0;
  if (!permitUnicode && value.charCodeAt(index) > 0x7f) return FAIL;
  return 2;
}

/** Skips spaces, tabs and CRLF pairs backwards; a lone CR or LF is invalid. */
function readFoldingWhiteSpaceReverse(value: string, index: number): number {
  let expectCr = false;
  for (; index >= 0; index--) {
    const char = value[index];
    if (char === '\r' && expectCr) {
      expectCr = false;
    } else if (char === '\r' || expectCr) {
      return FAIL;
    } else if (char === '\n') {
      expectCr = true;
    } else if (char !== ' ' && char !== '\t') {
      break;
    }
  }

  return expectCr ? FAIL : index;
}

const ATEXT_SPECIALS = "!#$%&'*+-/=?^_`{|}~";

function isAsciiAtext(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    ATEXT_SPECIALS.includes(char)
  );
}

/** RFC 5322 obs-NO-WS-CTL (1–8, 11, 12, 14–31, 127). */
function isNoWsCtl(code: number): boolean {
  return (code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
}

/** qtext (33, 35–91, 93–126) plus obs-qtext; any non-ASCII character is allowed in a quoted local part. */
function isQtext(code: number): boolean {
  return code > 0x7f || isNoWsCtl(code) || code === 33 || (code >= 35 && code <= 91) || (code >= 93 && code <= 126);
}

/** dtext (33–90, 94–126) plus obs-dtext; ASCII only. */
function isDtext(code: number): boolean {
  return isNoWsCtl(code) || (code >= 33 && code <= 90) || (code >= 94 && code <= 126);
}
