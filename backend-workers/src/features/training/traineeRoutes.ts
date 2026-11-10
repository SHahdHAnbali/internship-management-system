import type { Context } from 'hono';
import type { AppEnv } from '../../context';
import { DomainError } from '../../domain/errors';
import { required } from '../../domain/guard';
import {
  applicationHours,
  CONTENT_TYPE_MAX_LENGTH,
  FILE_NAME_MAX_LENGTH,
  period,
  traineeProfile,
  type ApplicationStatus,
} from '../../domain/training';
import { parseGuid, uuidV7 } from '../../domain/uuid';
import { json, statusProblem } from '../../http/problems';
import { routeId, type Route } from '../../http/routes';
import { applicationReceivedEmails, applicationSubmittedEmails, sendEventEmails } from '../notifications/eventEmails';
import { notifyHr } from '../notifications/notify';
import { readableAttachment } from './access';
import { fileLink, filesBucket, sha256Hex } from './files';

/**
 * `/api/trainee` (Trainee role only, always scoped to the signed-in trainee; PDF §2, §4, §9): the application form
 * with its CV and any university letters, and the status board of the trainee's own applications.
 */
interface ApplicationRow {
  id: string;
  field_id: string;
  field_name: string;
  status: ApplicationStatus;
  available_from: string;
  available_to: string;
  hours: number;
  mandatory_for_university: boolean;
  submitted_at: Date;
  decided_at: Date | null;
  rejection_reason: string | null;
}

interface AttachmentListRow {
  id: string;
  application_id: string;
  kind: string;
  file_name: string;
  size_bytes: string;
}

export const traineeRoutes: Route[] = [
  {
    // The active training fields offered on the form.
    method: 'GET',
    path: '/api/trainee/fields',
    policy: 'Trainee',
    async handle(c) {
      const { rows } = await c.var.db.query<{ id: string; name: string; description: string | null }>(
        'SELECT id, name, description FROM fields WHERE is_active ORDER BY name',
      );
      return json(rows);
    },
  },
  {
    method: 'GET',
    path: '/api/trainee/profile',
    policy: 'Trainee',
    async handle(c) {
      const { rows } = await c.var.db.query<Record<string, string | null>>(
        'SELECT email, full_name, phone, university, major, study_year FROM trainees WHERE id = $1',
        [c.var.user!.id],
      );
      const t = rows[0]!;
      return json({
        email: t.email,
        fullName: t.full_name,
        phone: t.phone,
        university: t.university,
        major: t.major,
        studyYear: t.study_year,
      });
    },
  },
  {
    // The status board: the trainee's own applications only, never anyone else's (PDF §4). The reason HR recorded is
    // shown for a rejected application (AD-61, Q36), including rejections recorded before that decision (NEW-25).
    method: 'GET',
    path: '/api/trainee/applications',
    policy: 'Trainee',
    async handle(c) {
      const { rows } = await c.var.db.query<ApplicationRow>(
        `SELECT a.id, a.field_id, f.name AS field_name, a.status, a.available_from::text, a.available_to::text, a.hours,
                a.mandatory_for_university, a.submitted_at, a.decided_at, a.rejection_reason
           FROM training_applications a JOIN fields f ON f.id = a.field_id
          WHERE a.trainee_id = $1 ORDER BY a.submitted_at DESC`,
        [c.var.user!.id],
      );
      const files = await attachmentsOf(
        c,
        rows.map((r) => r.id),
      );
      return json(
        rows.map((a) => ({
          id: a.id,
          field: { id: a.field_id, name: a.field_name },
          status: a.status,
          availableFrom: a.available_from,
          availableTo: a.available_to,
          hours: a.hours,
          mandatoryForUniversity: a.mandatory_for_university,
          submittedAt: a.submitted_at,
          decidedAt: a.decided_at,
          rejectionReason: a.status === 'Rejected' ? a.rejection_reason : null,
          attachments: files.get(a.id) ?? [],
        })),
      );
    },
  },
  {
    // Submits an application (PDF §4): multipart form with the profile, the request, the CV and any university letters.
    method: 'POST',
    path: '/api/trainee/applications',
    policy: 'Trainee',
    rateLimited: true,
    async handle(c) {
      const form = await readForm(c);
      if (!form) return statusProblem(415, c.var.traceId, true);
      const text = (name: string) => {
        const value = form.get(name);
        return typeof value === 'string' ? value : null;
      };

      // The profile (PDF §8) is recorded by the trainee's first application and never overwritten by a later one; how a
      // recorded profile may change is not defined yet, so a later form's profile fields are not used.
      const { rows: me } = await c.var.db.query<{ full_name: string | null }>(
        'SELECT full_name FROM trainees WHERE id = $1',
        [c.var.user!.id],
      );
      const profile =
        me[0]?.full_name == null
          ? traineeProfile({
              fullName: text('fullName'),
              phone: text('phone'),
              university: text('university'),
              major: text('major'),
              studyYear: text('studyYear'),
            })
          : null;
      const fieldId = parseGuid(text('fieldId') ?? '');
      if (!fieldId) throw new DomainError('validation.required', 'Field is required.');
      const available = period(
        text('availableFrom'),
        text('availableTo'),
        'The available period',
        'application.invalid_period',
      );
      const hours = applicationHours(text('hours'));
      const mandatory = text('mandatoryForUniversity');
      if (mandatory !== 'true' && mandatory !== 'false') {
        throw new DomainError(
          'validation.required',
          'Whether the training is mandatory for the university is required.',
        );
      }

      const cv = form.getAll('cv').filter((v): v is File => typeof v !== 'string' && v.size > 0);
      if (cv.length !== 1) throw new DomainError('application.cv_required', 'Attach your CV (one file).');
      const letters = form.getAll('letters').filter((v): v is File => typeof v !== 'string' && v.size > 0);

      const { rows: fields } = await c.var.db.query('SELECT 1 FROM fields WHERE id = $1 AND is_active', [fieldId]);
      if (fields.length === 0)
        throw new DomainError('application.field_unavailable', 'The selected field is not available.');

      // Files first, then the records that reference them (one transaction).
      const now = c.var.deps.now();
      const applicationId = uuidV7(now);
      const files: {
        id: string;
        kind: 'Cv' | 'UniversityLetter';
        fileName: string;
        contentType: string;
        size: number;
        sha256: string;
        key: string;
      }[] = [];
      for (const [kind, file] of [
        ...cv.map((f) => ['Cv', f] as const),
        ...letters.map((f) => ['UniversityLetter', f] as const),
      ]) {
        const id = uuidV7(now);
        const bytes = await file.arrayBuffer();
        const contentType = required(file.type || 'application/octet-stream', 'Content type', CONTENT_TYPE_MAX_LENGTH);
        const key = `applications/${applicationId}/${id}`;
        await filesBucket(c).put(key, bytes, { httpMetadata: { contentType } });
        files.push({
          id,
          kind,
          fileName: required(file.name || 'file', 'File name', FILE_NAME_MAX_LENGTH),
          contentType,
          size: bytes.byteLength,
          sha256: await sha256Hex(bytes),
          key,
        });
      }

      const traineeId = c.var.user!.id;
      await c.var.db.transaction(c.var.actor, async (tx) => {
        if (profile) {
          await tx.query(
            `UPDATE trainees SET full_name = $2, phone = $3, university = $4, major = $5, study_year = $6
              WHERE id = $1 AND full_name IS NULL`,
            [traineeId, profile.fullName, profile.phone, profile.university, profile.major, profile.studyYear],
          );
        }
        await tx.query(
          `INSERT INTO training_applications
             (id, trainee_id, field_id, status, available_from, available_to, hours, mandatory_for_university, submitted_at)
           VALUES ($1, $2, $3, 'Submitted', $4, $5, $6, $7, $8)`,
          [applicationId, traineeId, fieldId, available.start, available.end, hours, mandatory === 'true', now],
        );
        for (const f of files) {
          await tx.query(
            `INSERT INTO application_attachments
               (id, application_id, kind, file_name, content_type, size_bytes, sha256, storage_key, uploaded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [f.id, applicationId, f.kind, f.fileName, f.contentType, f.size, f.sha256, f.key, now],
          );
        }
        await notifyHr(tx, 'ApplicationSubmitted', applicationId, now); // PDF §7: "new training application"
      });
      // PDF §7, after the commit (best effort, if enabled): "application received (confirmation)" to the trainee and
      // "new training application" to every HR user (NEW-24).
      await sendEventEmails(c, async (q) => [
        ...(await applicationReceivedEmails(q, applicationId)),
        ...(await applicationSubmittedEmails(q, applicationId)),
      ]);

      return json({ id: applicationId, status: 'Submitted' }, 201, {
        Location: `/api/trainee/applications/${applicationId}`,
      });
    },
  },
  {
    // A temporary link to one of the trainee's own files.
    method: 'POST',
    path: '/api/trainee/attachments/:id/link',
    policy: 'Trainee',
    async handle(c) {
      const attachment = await readableAttachment(c.var.db, c.var.user!, routeId(c));
      if (!attachment) return statusProblem(404, c.var.traceId, true);
      return json(await fileLink(c, attachment.id, c.var.user!.id));
    },
  },
];

async function readForm(c: Context<AppEnv>): Promise<FormData | null> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return null;
  try {
    return await c.req.raw.formData();
  } catch {
    throw new DomainError('validation.invalid', 'The form could not be read.');
  }
}

export async function attachmentsOf(c: Context<AppEnv>, applicationIds: string[]) {
  const byApplication = new Map<string, { id: string; kind: string; fileName: string; sizeBytes: number }[]>();
  if (applicationIds.length === 0) return byApplication;
  const { rows } = await c.var.db.query<AttachmentListRow>(
    `SELECT id, application_id, kind, file_name, size_bytes::text FROM application_attachments
      WHERE application_id = ANY($1) ORDER BY uploaded_at, kind`,
    [applicationIds],
  );
  for (const r of rows) {
    const list = byApplication.get(r.application_id) ?? [];
    list.push({ id: r.id, kind: r.kind, fileName: r.file_name, sizeBytes: Number(r.size_bytes) });
    byApplication.set(r.application_id, list);
  }

  return byApplication;
}
