import { describe, expect, it } from 'vitest';
import {
  ARABIC_FONTS,
  DEFAULT_CERTIFICATE_SETTINGS,
  ENGLISH_FONTS,
  type CertificateSettings,
} from '../src/domain/certificateTemplate';
import { body, createTestApi, signInStaff, signInTrainee, uniqueEmail, withDb } from './helpers';

/**
 * Admin certificate template (AD-43): authorization, validation, persistence with optimistic concurrency, reset to the
 * default design, images, audit and the no-delete protection. Tests in this file run in order (one template row).
 */
const api = createTestApi();
const URL = '/api/admin/certificate-template';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

interface TemplateResponse {
  settings: CertificateSettings;
  defaultSettings: CertificateSettings;
  isDefault: boolean;
  version: string | null;
  updatedAt: string | null;
  logo: { contentType: string } | null;
  signature: { contentType: string } | null;
}

const clone = (settings: CertificateSettings): CertificateSettings => structuredClone(settings);

async function admin() {
  return (await signInStaff(api, 'Admin')).client;
}

function upload(client: Awaited<ReturnType<typeof admin>>, kind: string, bytes: Uint8Array, contentType: string) {
  return client.request('PUT', `${URL}/${kind}`, bytes, { 'content-type': contentType });
}

describe('authorization', () => {
  const endpoints: [string, string][] = [
    ['GET', URL],
    ['PUT', URL],
    ['GET', `${URL}/logo`],
    ['PUT', `${URL}/logo`],
    ['DELETE', `${URL}/signature`],
  ];

  it('signed-out requests are 401', async () => {
    for (const [method, url] of endpoints) {
      expect((await api.client().request(method, url)).status, `${method} ${url}`).toBe(401);
    }
  });

  it('HR, Employee, trainees and ordinary Google users are 403', async () => {
    const google = api.client();
    await google.post('/api/auth/staff/google', { idToken: await api.google.issue(uniqueEmail('gmail.com'), null) });
    const clients = [
      (await signInStaff(api, 'HR')).client,
      (await signInStaff(api, 'Employee')).client,
      (await signInTrainee(api)).client,
      google,
    ];
    for (const client of clients) {
      for (const [method, url] of endpoints) {
        expect((await client.request(method, url, method === 'PUT' ? {} : undefined)).status, `${method} ${url}`).toBe(
          403,
        );
      }
    }
  });
});

describe('template', () => {
  it('starts with the default design and no saved row', async () => {
    const response = await (await admin()).get(URL);
    expect(response.status).toBe(200);
    const template = await body<TemplateResponse>(response);
    expect(template).toEqual({
      settings: DEFAULT_CERTIFICATE_SETTINGS,
      defaultSettings: DEFAULT_CERTIFICATE_SETTINGS,
      isDefault: true,
      version: null,
      updatedAt: null,
      logo: null,
      signature: null,
    });
  });

  it('saves, reloads and audits the template, with the Admin as actor', async () => {
    const { client, user } = await signInStaff(api, 'Admin');
    const settings = clone(DEFAULT_CERTIFICATE_SETTINGS);
    settings.layout.preset = 'modern';
    settings.colors.primary = '#1A2B3C';
    settings.text.title.en = '  Internship Certificate  ';

    const saved = await body<TemplateResponse>(await client.put(URL, { settings, version: null }));
    expect(saved.isDefault).toBe(false);
    expect(saved.version).toMatch(/^\d+$/);
    expect(saved.settings.colors.primary).toBe('#1a2b3c'); // normalised
    expect(saved.settings.text.title.en).toBe('Internship Certificate'); // trimmed
    expect(await body(await client.get(URL))).toEqual(saved);

    const audit = await withDb((db) =>
      db.query(
        "SELECT operation, actor_type, actor_id FROM audit_logs WHERE table_name = 'certificate_templates' ORDER BY id",
      ),
    );
    expect(audit.rows).toEqual([{ operation: 'INSERT', actor_type: 'Staff', actor_id: user.id }]);
  });

  it('refuses a save based on an outdated version (409), and accepts the current one', async () => {
    const client = await admin();
    const current = await body<TemplateResponse>(await client.get(URL));

    const stale = await client.put(URL, { settings: current.settings, version: null });
    expect(stale.status).toBe(409);
    expect((await body(stale)).code).toBe('conflict.concurrent_update');

    const settings = clone(current.settings);
    settings.typography.titleSize = 'medium';
    const ok = await client.put(URL, { settings, version: current.version });
    expect(ok.status).toBe(200);
    expect((await client.put(URL, { settings, version: current.version })).status).toBe(409); // now outdated

    const update = await withDb((db) =>
      db.query(
        `SELECT array(SELECT jsonb_object_keys(new_values) ORDER BY 1) AS columns FROM audit_logs
          WHERE table_name = 'certificate_templates' AND operation = 'UPDATE' ORDER BY id DESC LIMIT 1`,
      ),
    );
    expect(update.rows[0].columns).toEqual(['settings', 'updated_at']);
  });

  it('reset to default saves the default design', async () => {
    const client = await admin();
    const current = await body<TemplateResponse>(await client.get(URL));
    const reset = await body<TemplateResponse>(
      await client.put(URL, { settings: current.defaultSettings, version: current.version }),
    );
    expect(reset.settings).toEqual(DEFAULT_CERTIFICATE_SETTINGS);
    expect(reset.isDefault).toBe(false); // a saved row that holds the default design
  });
});

describe('validation', () => {
  const invalidCases: [string, (s: CertificateSettings & Record<string, unknown>) => void, string][] = [
    ['colour', (s) => (s.colors.primary = 'red'), 'colors.primary'],
    ['option', (s) => ((s.layout as Record<string, unknown>).preset = 'baroque'), 'layout.preset'],
    ['unknown setting', (s) => ((s.layout as Record<string, unknown>).x = 1), 'layout.x'],
    ['trainee data in the template', (s) => (s.traineeName = 'Sara'), 'settings.traineeName'],
    ['text too long', (s) => (s.text.title.ar = 'ش'.repeat(81)), 'text.title.ar'],
    ['missing text for a used language', (s) => (s.text.intro.en = '   '), 'text.intro.en'],
    ['control characters', (s) => (s.text.footer.en = 'a\u0000b'), 'text.footer.en'],
    ['boolean', (s) => ((s.elements as Record<string, unknown>).showTrainerName = 'yes'), 'elements.showTrainerName'],
    ['signature and QR code in the same place', (s) => (s.qrCode.position = s.signature.position), 'qrCode.position'],
    ['schema version', (s) => ((s as Record<string, unknown>).schemaVersion = 3), 'schemaVersion'],
    [
      'English font',
      (s) => ((s.typography.headingFont as unknown as Record<string, unknown>).en = 'comic-sans'),
      'typography.headingFont.en',
    ],
    [
      'Arabic font in the English slot',
      (s) => ((s.typography.bodyFont as unknown as Record<string, unknown>).en = 'cairo'),
      'typography.bodyFont.en',
    ],
    [
      'English font in the Arabic slot',
      (s) => ((s.typography.bodyFont as unknown as Record<string, unknown>).ar = 'lora'),
      'typography.bodyFont.ar',
    ],
    [
      'font pair shape',
      (s) => ((s.typography as Record<string, unknown>).headingFont = 'serif'),
      'typography.headingFont',
    ],
  ];

  it.each(invalidCases)('rejects an invalid %s with the setting named', async (_name, change, path) => {
    const client = await admin();
    const current = await body<TemplateResponse>(await client.get(URL));
    const settings = clone(current.settings) as CertificateSettings & Record<string, unknown>;
    change(settings);

    const response = await client.put(URL, { settings, version: current.version });

    expect(response.status).toBe(400);
    const problem = await body(response);
    expect(problem.code).toBe('certificate.invalid_settings');
    expect(problem.detail).toContain(`'${path}'`);
    expect((await body<TemplateResponse>(await client.get(URL))).version).toBe(current.version); // nothing written
  });

  it('accepts texts only in the certificate language, and a hidden signature anywhere', async () => {
    const client = await admin();
    const current = await body<TemplateResponse>(await client.get(URL));
    const settings = clone(current.settings);
    settings.language = 'en';
    settings.text.title.ar = '';
    settings.signature = { visible: false, size: 'small', position: settings.qrCode.position };
    expect((await client.put(URL, { settings, version: current.version })).status).toBe(200);
  });

  it('accepts every catalogue font for headings and body text, in English and Arabic', async () => {
    const client = await admin();
    let current = await body<TemplateResponse>(await client.get(URL));
    const pairs = ENGLISH_FONTS.map((en, i) => ({ en, ar: ARABIC_FONTS[i % ARABIC_FONTS.length]! }));
    for (const [i, pair] of pairs.entries()) {
      const settings = clone(current.settings);
      settings.typography.headingFont = pair;
      settings.typography.bodyFont = {
        en: ENGLISH_FONTS[(i + 3) % ENGLISH_FONTS.length]!,
        ar: ARABIC_FONTS[(i + 5) % ARABIC_FONTS.length]!,
      };
      const response = await client.put(URL, { settings, version: current.version });
      expect(response.status, JSON.stringify(pair)).toBe(200);
      current = await body<TemplateResponse>(response);
      expect(current.settings.typography.headingFont).toEqual(pair);
    }

    expect([...ENGLISH_FONTS, ...ARABIC_FONTS]).toHaveLength(18);
  });

  it('upgrades a schema version 1 template (saved earlier) to the same fonts, on read and on save', async () => {
    const client = await admin();
    const current = await body<TemplateResponse>(await client.get(URL));
    const legacy = {
      ...clone(current.settings),
      schemaVersion: 1,
      typography: { ...current.settings.typography, headingFont: 'elegant', bodyFont: 'serif' },
    };

    // Saved by the editor before this change: still accepted.
    const saved = await body<TemplateResponse>(await client.put(URL, { settings: legacy, version: current.version }));
    expect(saved.settings.schemaVersion).toBe(2);
    expect(saved.settings.typography.headingFont).toEqual({ en: 'cormorant-garamond', ar: 'amiri' });
    expect(saved.settings.typography.bodyFont).toEqual({ en: 'noto-serif', ar: 'noto-naskh-arabic' });

    // Stored as version 1 (as an older API version wrote it): read back upgraded, without rewriting the row.
    await withDb((db) =>
      db.query(
        "UPDATE certificate_templates SET settings = jsonb_set(settings, '{typography}', $1::jsonb) || '{\"schemaVersion\": 1}'",
        [JSON.stringify({ ...legacy.typography, headingFont: 'sans', bodyFont: 'sans' })],
      ),
    );
    const read = await body<TemplateResponse>(await client.get(URL));
    expect(read.settings.schemaVersion).toBe(2);
    expect(read.settings.typography.headingFont).toEqual({ en: 'inter', ar: 'noto-sans-arabic' });
    const stored = await withDb((db) =>
      db.query("SELECT settings ->> 'schemaVersion' AS v FROM certificate_templates"),
    );
    expect(stored.rows[0].v).toBe('1');

    const restored = await client.put(URL, { settings: read.settings, version: read.version });
    expect(restored.status).toBe(200);
  });

  it('requires the settings object', async () => {
    const response = await (await admin()).put(URL, { version: null });
    expect(response.status).toBe(400);
    expect((await body(response)).errors).toEqual({ Settings: ['The Settings field is required.'] });
  });
});

describe('images', () => {
  it('uploads, serves and removes the logo and the signature (PNG, JPEG, WebP)', async () => {
    const client = await admin();
    const before = await body<TemplateResponse>(await client.get(URL));

    const logo = await upload(client, 'logo', PNG, 'image/png');
    expect(logo.status).toBe(200);
    const afterLogo = await body<TemplateResponse>(logo);
    expect(afterLogo.logo).toEqual({ contentType: 'image/png' });
    expect(afterLogo.version).not.toBe(before.version);
    expect(afterLogo.settings).toEqual(before.settings);

    const served = await client.get(`${URL}/logo`);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    expect((await upload(client, 'signature', JPEG, 'image/jpeg')).status).toBe(200);
    const webp = await body<TemplateResponse>(await upload(client, 'signature', WEBP, 'image/webp'));
    expect(webp.signature).toEqual({ contentType: 'image/webp' });

    const removed = await body<TemplateResponse>(await client.request('DELETE', `${URL}/logo`));
    expect(removed.logo).toBeNull();
    expect(removed.signature).toEqual({ contentType: 'image/webp' });
    expect((await client.get(`${URL}/logo`)).status).toBe(404);
  });

  it('refuses other file types, disguised files, empty and oversized images', async () => {
    const client = await admin();
    expect(
      (await upload(client, 'logo', new TextEncoder().encode('<svg onload="x()"/>'), 'image/svg+xml')).status,
    ).toBe(415);
    expect((await upload(client, 'logo', PNG, 'text/plain')).status).toBe(415);

    const disguised = await upload(client, 'logo', JPEG, 'image/png');
    expect(disguised.status).toBe(400);
    expect((await body(disguised)).code).toBe('certificate.invalid_image');
    expect((await upload(client, 'logo', new Uint8Array(), 'image/png')).status).toBe(400);

    const big = new Uint8Array(512 * 1024 + 1);
    big.set(PNG);
    const tooLarge = await upload(client, 'logo', big, 'image/png');
    expect(tooLarge.status).toBe(400);
    expect((await body(tooLarge)).code).toBe('certificate.image_too_large');
    expect((await body<TemplateResponse>(await client.get(URL))).logo).toBeNull();
  });

  it('an image upload makes an editor holding the old version reload before saving', async () => {
    const client = await admin();
    const current = await body<TemplateResponse>(await client.get(URL));
    await upload(client, 'logo', PNG, 'image/png');
    expect((await client.put(URL, { settings: current.settings, version: current.version })).status).toBe(409);
  });
});

describe('audit log for images', () => {
  const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it('records who uploaded, replaced and removed an image, with its size and hash but never its content', async () => {
    const { client, user } = await signInStaff(api, 'Admin');
    const first = new Uint8Array([...PNG, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);
    const second = new Uint8Array([...JPEG, 0x5a, 0x59, 0x58, 0x57, 0x56, 0x55]);
    const before = await withDb((db) => db.query('SELECT coalesce(max(id), 0) AS id FROM audit_logs'));

    await client.request('DELETE', `${URL}/signature`); // start without a signature
    const startId = (await withDb((db) => db.query('SELECT coalesce(max(id), 0) AS id FROM audit_logs'))).rows[0].id;
    expect((await upload(client, 'signature', first, 'image/png')).status).toBe(200);
    expect((await upload(client, 'signature', first, 'image/png')).status).toBe(200); // same image again: no change
    expect((await upload(client, 'signature', second, 'image/jpeg')).status).toBe(200);
    expect((await client.request('DELETE', `${URL}/signature`)).status).toBe(200);

    const rows = (
      await withDb((db) =>
        db.query(
          `SELECT actor_type, actor_id, old_values -> 'signature_image' AS old, new_values -> 'signature_image' AS new,
                  old_values::text AS old_text, new_values::text AS new_text
             FROM audit_logs
            WHERE table_name = 'certificate_templates' AND id > $1 AND new_values ? 'signature_image'
            ORDER BY id`,
          [startId],
        ),
      )
    ).rows;

    const firstMeta = { bytes: first.length, sha256: await sha256(first) };
    const secondMeta = { bytes: second.length, sha256: await sha256(second) };
    expect(rows.map((r) => ({ old: r.old, new: r.new }))).toEqual([
      { old: null, new: { action: 'uploaded', ...firstMeta } },
      { old: firstMeta, new: { action: 'replaced', ...secondMeta } },
      { old: secondMeta, new: { action: 'removed' } },
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actor_type: 'Staff', actor_id: user.id });
    }

    // No image content in any form, in any certificate audit row written since.
    const texts = (
      await withDb((db) =>
        db.query(
          "SELECT coalesce(old_values::text, '') || new_values::text AS t FROM audit_logs WHERE table_name = 'certificate_templates' AND id > $1",
          [before.rows[0].id],
        ),
      )
    ).rows.map((r) => r.t as string);
    for (const image of [first, second]) {
      for (const encoded of [hex(image), base64(image), `\\\\x${hex(image)}`]) {
        expect(texts.some((t) => t.includes(encoded))).toBe(false);
      }
    }
  });

  it('a settings save is audited without any image columns', async () => {
    const client = await admin();
    await upload(client, 'logo', PNG, 'image/png');
    const current = await body<TemplateResponse>(await client.get(URL));
    const settings = clone(current.settings);
    settings.colors.text = '#222222';
    expect((await client.put(URL, { settings, version: current.version })).status).toBe(200);

    const last = await withDb((db) =>
      db.query(
        `SELECT array(SELECT jsonb_object_keys(new_values) ORDER BY 1) AS columns, old_values::text AS old_text
           FROM audit_logs WHERE table_name = 'certificate_templates' ORDER BY id DESC LIMIT 1`,
      ),
    );
    expect(last.rows[0].columns).toEqual(['settings', 'updated_at']);
    expect(last.rows[0].old_text).not.toContain(hex(PNG));
  });

  it('other tables are audited exactly as before', async () => {
    const { client } = await signInStaff(api, 'Admin');
    const field = await body(
      await client.post('/api/admin/fields', { name: `Audit ${crypto.randomUUID().slice(0, 8)}` }),
    );
    const entry = await withDb((db) =>
      db.query('SELECT operation, new_values FROM audit_logs WHERE entity_id = $1', [field.id]),
    );
    expect(entry.rows).toEqual([
      {
        operation: 'INSERT',
        new_values: { id: field.id, name: field.name, description: null, is_active: true },
      },
    ]);
  });
});

describe('database protections', () => {
  it('the template row cannot be deleted or truncated, and rejects invalid images', async () => {
    for (const sql of ['DELETE FROM certificate_templates', 'TRUNCATE certificate_templates']) {
      const error = await withDb((db) =>
        db.query(sql).then(
          () => null,
          (e: { code: string }) => e,
        ),
      );
      expect(error?.code, sql).toBe('23001');
    }

    const check = await withDb((db) =>
      db.query("UPDATE certificate_templates SET logo_content_type = 'image/svg+xml'").then(
        () => null,
        (e: { code: string }) => e,
      ),
    );
    expect(check?.code).toBe('23514'); // check_violation
    const typeWithoutImage = await withDb((db) =>
      db.query("UPDATE certificate_templates SET signature_image = NULL, signature_content_type = 'image/png'").then(
        () => null,
        (e: { code: string }) => e,
      ),
    );
    expect(typeWithoutImage?.code).toBe('23514');
  });
});
