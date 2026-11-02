import type { Context } from 'hono';
import { base64Url } from '../../auth/session';
import { ConfigurationError } from '../../domain/errors';
import type { AppEnv } from '../../context';
import { statusProblem } from '../../http/problems';
import type { Route } from '../../http/routes';
import { readableAttachment } from './access';

/**
 * Application files (CVs, university letters) in the private R2 bucket `FILES` (owner decision 2026-10-29); their
 * references and metadata are in PostgreSQL. Files are never public (PDF §9: served through temporary links): an
 * authorized user gets a link that works for LINK_LIFETIME_MS and only in their own session, and the permission is
 * checked again when the file is read.
 */
const LINK_LIFETIME_MS = 5 * 60_000;
const LINK_INFO = new TextEncoder().encode('ims.file-link.v1');

export function filesBucket(c: Context<AppEnv>): R2Bucket {
  if (!c.env.FILES)
    throw new ConfigurationError('The FILES R2 bucket binding is missing (wrangler.jsonc "r2_buckets").');
  return c.env.FILES;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A temporary link to an attachment for the signed-in `userId`. */
export async function fileLink(c: Context<AppEnv>, attachmentId: string, userId: string) {
  const expires = c.var.deps.now().getTime() + LINK_LIFETIME_MS;
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ f: attachmentId, u: userId, e: expires })));
  const signature = await sign(c, payload);
  return { url: `/api/files?token=${payload}.${signature}`, expiresAt: new Date(expires).toISOString() };
}

async function sign(c: Context<AppEnv>, payload: string): Promise<string> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(c.var.settings.sessionSecrets[0]!),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ims.files'), info: LINK_INFO },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

async function verify(c: Context<AppEnv>, token: string): Promise<{ f: string; u: string } | null> {
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length > 0) return null;
  const expected = await sign(c, payload);
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) return null;
  try {
    const value = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      f?: unknown;
      u?: unknown;
      e?: unknown;
    };
    if (typeof value.f !== 'string' || typeof value.u !== 'string' || typeof value.e !== 'number') return null;
    return c.var.deps.now().getTime() < value.e ? { f: value.f, u: value.u } : null;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** `Content-Disposition` with the original name (RFC 6266/5987); PDFs open in the browser, other files download. */
function disposition(fileName: string, contentType: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const type = contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf' ? 'inline' : 'attachment';
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export const fileRoutes: Route[] = [
  {
    // A temporary link: valid for its own user only, briefly, and only while that user may still read the file.
    method: 'GET',
    path: '/api/files',
    policy: 'authenticated',
    async handle(c) {
      const user = c.var.user!;
      const link = await verify(c, c.req.query('token') ?? '');
      if (!link || link.u !== user.id) return statusProblem(404, c.var.traceId, true);

      const attachment = await readableAttachment(c.var.db, user, link.f);
      if (!attachment) return statusProblem(404, c.var.traceId, true);
      const object = await filesBucket(c).get(attachment.storage_key);
      if (!object) return statusProblem(404, c.var.traceId, true);

      return new Response(object.body, {
        headers: {
          'Content-Type': attachment.content_type,
          'Content-Length': attachment.size_bytes,
          'Content-Disposition': disposition(attachment.file_name, attachment.content_type),
          // Uploaded content is never run in the site's context.
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        },
      });
    },
  },
];
