import { Buffer } from 'node:buffer';
import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { updateOrConflict, type Queryable } from '../../db';
import {
  DEFAULT_CERTIFICATE_SETTINGS,
  validateCertificateSettings,
  type CertificateSettings,
} from '../../domain/certificateTemplate';
import { ConcurrencyError, DomainError, NotFoundError } from '../../domain/errors';
import { bindJson, type RequestSchema } from '../../http/body';
import { json, statusProblem } from '../../http/problems';
import type { Route } from '../../http/routes';

/**
 * Admin: the certificate template (PDF §4, §5; AD-43). One row (`certificate_templates`, id 1) created on the first
 * save; until then the default design is returned. Images (company logo, HR signature) are stored in the row: PNG, JPEG
 * or WebP up to 512 KB, checked by their file signature. Every write is a normal audited transaction; nothing is
 * deleted (removing an image clears its columns). Optimistic concurrency uses the row's `xmin` as `version`.
 */
export const CERTIFICATE_IMAGE_MAX_BYTES = 512 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];
type ImageKind = 'logo' | 'signature';

const BASE = '/api/admin/certificate-template';

const saveRequest: RequestSchema = {
  typeName: 'CertificateTemplateRequest',
  properties: [
    { name: 'Settings', kind: 'object', required: true },
    { name: 'Version', kind: 'string' },
  ],
};

interface TemplateRow {
  settings: CertificateSettings;
  logo_content_type: string | null;
  signature_content_type: string | null;
  updated_at: Date;
  version: string;
}

/** The template as the editor needs it: saved (or default) settings, the defaults for "Reset", and image presence. */
async function readTemplate(db: Queryable) {
  const { rows } = await db.query<TemplateRow>(
    `SELECT settings, logo_content_type, signature_content_type, updated_at, xmin::text AS version
       FROM certificate_templates WHERE id = 1`,
  );
  const row = rows[0];
  return {
    // Templates saved with an earlier schema version are upgraded on read (same look); the row is not rewritten.
    settings: row ? validateCertificateSettings(row.settings) : DEFAULT_CERTIFICATE_SETTINGS,
    defaultSettings: DEFAULT_CERTIFICATE_SETTINGS,
    isDefault: !row,
    version: row?.version ?? null,
    updatedAt: row?.updated_at.toISOString() ?? null,
    logo: row?.logo_content_type ? { contentType: row.logo_content_type } : null,
    signature: row?.signature_content_type ? { contentType: row.signature_content_type } : null,
  };
}

export const certificateTemplateRoutes: Route[] = [
  {
    method: 'GET',
    path: BASE,
    policy: 'Admin',
    async handle(c) {
      return json(await readTemplate(c.var.db));
    },
  },
  {
    method: 'PUT',
    path: BASE,
    policy: 'Admin',
    async handle(c) {
      const body = await bindJson<{ settings: Record<string, unknown>; version: string | null }>(
        c.req.raw,
        saveRequest,
        c.var.traceId,
      );
      if (!body.ok) return body.response;

      const settings = validateCertificateSettings(body.value.settings);
      const now = c.var.deps.now().toISOString();
      await c.var.db.transaction(c.var.actor, async (tx) => {
        if (body.value.version === null) {
          // First save. If someone else saved first, their row exists: a conflict, like a stale version.
          const { rowCount } = await tx.query(
            `INSERT INTO certificate_templates (id, settings, updated_at) VALUES (1, $1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [JSON.stringify(settings), now],
          );
          if (rowCount === 0) throw new ConcurrencyError();
        } else {
          await updateOrConflict(
            tx,
            'UPDATE certificate_templates SET settings = $1, updated_at = $2 WHERE id = 1 AND xmin = $3::xid',
            [JSON.stringify(settings), now, body.value.version],
          );
        }
      });
      return json(await readTemplate(c.var.db));
    },
  },
  ...(['logo', 'signature'] as const).flatMap((kind): Route[] => [
    { method: 'GET', path: `${BASE}/${kind}`, policy: 'Admin', handle: (c) => getImage(c, kind) },
    { method: 'PUT', path: `${BASE}/${kind}`, policy: 'Admin', handle: (c) => putImage(c, kind) },
    { method: 'DELETE', path: `${BASE}/${kind}`, policy: 'Admin', handle: (c) => removeImage(c, kind) },
  ]),
];

async function getImage(c: Context<AppEnv>, kind: ImageKind): Promise<Response> {
  const { rows } = await c.var.db.query<{ image: Buffer | null; content_type: string | null }>(
    `SELECT ${kind}_image AS image, ${kind}_content_type AS content_type FROM certificate_templates WHERE id = 1`,
  );
  const row = rows[0];
  if (!row?.image || !row.content_type) throw new NotFoundError(`The certificate ${kind} image was not uploaded.`);
  return new Response(new Uint8Array(row.image), {
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

async function putImage(c: Context<AppEnv>, kind: ImageKind): Promise<Response> {
  const contentType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(IMAGE_TYPES as readonly string[]).includes(contentType)) {
    return statusProblem(415, c.var.traceId, true);
  }

  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > CERTIFICATE_IMAGE_MAX_BYTES) throw tooLarge();
  const bytes = await readLimited(c.req.raw, CERTIFICATE_IMAGE_MAX_BYTES);
  if (bytes.length === 0 || !matchesSignature(bytes, contentType as ImageType)) {
    throw new DomainError(
      'certificate.invalid_image',
      `The file is not a valid ${contentType.slice(6).toUpperCase()} image.`,
    );
  }

  const now = c.var.deps.now().toISOString();
  await c.var.db.transaction(c.var.actor, async (tx) => {
    // The row may not exist yet: create it with the default design, then attach the image.
    await tx.query(
      `INSERT INTO certificate_templates (id, settings, updated_at) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(DEFAULT_CERTIFICATE_SETTINGS), now],
    );
    await tx.query(
      `UPDATE certificate_templates SET ${kind}_image = $1, ${kind}_content_type = $2, updated_at = $3 WHERE id = 1`,
      [Buffer.from(bytes), contentType, now],
    );
  });
  return json(await readTemplate(c.var.db));
}

async function removeImage(c: Context<AppEnv>, kind: ImageKind): Promise<Response> {
  const now = c.var.deps.now().toISOString();
  await c.var.db.transaction(c.var.actor, (tx) =>
    tx.query(
      `UPDATE certificate_templates SET ${kind}_image = NULL, ${kind}_content_type = NULL, updated_at = $1
        WHERE id = 1 AND ${kind}_image IS NOT NULL`,
      [now],
    ),
  );
  return json(await readTemplate(c.var.db));
}

function tooLarge(): DomainError {
  return new DomainError(
    'certificate.image_too_large',
    `The image must be at most ${CERTIFICATE_IMAGE_MAX_BYTES / 1024} KB.`,
  );
}

/** Reads the request body, stopping as soon as it exceeds `max` bytes. */
async function readLimited(request: Request, max: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/** The file signature must match the declared type (a renamed or disguised file is refused). */
function matchesSignature(bytes: Uint8Array, type: ImageType): boolean {
  const starts = (signature: number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte);
  switch (type) {
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'image/webp':
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  }
}
