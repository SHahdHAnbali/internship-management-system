import { API_BASE_URL, type MockResponse } from '../../../lib/api';
import { STAFF_ROLES, type UserRole } from '../models';
import { adminPreviewSeed } from './adminPreviewData';

const LATENCY_MS = 300;

/**
 * In-memory stand-in for the Admin API, used only in Admin Preview Mode. Mirrors the real API's validation and status
 * codes (400 invalid, 404 unknown id, 409 duplicate field name). A page reload restores the sample data.
 */
export class AdminPreviewStore {
  private readonly prefix = `${API_BASE_URL}/admin/`;
  private data = adminPreviewSeed();

  reset(): void {
    this.data = adminPreviewSeed();
  }

  /** Returns a mock response for an Admin API request, or null when the request is not an Admin API call. */
  handle(method: string, url: string, body: unknown): Promise<MockResponse> | null {
    const path = url.split('?')[0];
    if (!path.startsWith(this.prefix)) return null;

    const [resource, id, sub] = path.slice(this.prefix.length).split('/');
    const input = (body ?? {}) as Record<string, unknown>;
    const route = `${method} ${resource}${id ? '/:id' : ''}${sub ? `/${sub}` : ''}`;

    switch (route) {
      case 'GET fields':
        return this.ok([...this.data.fields].sort((a, b) => a.name.localeCompare(b.name)));
      case 'POST fields':
        return this.saveField(null, input);
      case 'PUT fields/:id':
        return this.saveField(id, input);
      case 'GET evaluation-criteria':
        return this.ok(
          [...this.data.criteria].sort(
            (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
          ),
        );
      case 'POST evaluation-criteria':
        return this.saveCriterion(null, input);
      case 'PUT evaluation-criteria/:id':
        return this.saveCriterion(id, input);
      case 'GET users':
        return this.ok([...this.data.users].sort((a, b) => a.fullName.localeCompare(b.fullName)));
      case 'PUT users/:id/role':
        return this.changeRole(id, input['role']);
      case 'GET accepted-trainees':
        return this.ok([]); // Preview Mode has no trainee records
      case 'GET reports/:id':
        if (id === 'fields') return this.fieldsReport(url);
        return id === 'monthly' ? this.monthlyReport(url) : this.error(404);
      case 'GET reports/:id/filters':
        return id === 'monthly' ? this.ok({ fields: [], employees: [] }) : this.error(404);
      case 'GET settings/:id':
        return id === 'notifications' ? this.ok(this.data.settings) : this.error(404);
      case 'PUT settings/:id':
        return id === 'notifications' ? this.saveSettings(input) : this.error(404);
      case 'GET certificate-template':
        return this.ok(this.data.certificateTemplate);
      case 'PUT certificate-template':
        return this.saveCertificateTemplate(input);
      case 'PUT certificate-template/:id':
      case 'DELETE certificate-template/:id':
        return this.setCertificateImage(id, method === 'PUT' ? body : null);
      default:
        return this.error(404);
    }
  }

  private saveField(id: string | null, body: Record<string, unknown>) {
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const description =
      typeof body['description'] === 'string' ? body['description'].trim() || null : null;
    if (!name || name.length > 100 || (description?.length ?? 0) > 1000) return this.error(400);

    const existing = id ? this.data.fields.find((f) => f.id === id) : undefined;
    if (id && !existing) return this.error(404);
    if (this.data.fields.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase()))
      return this.error(409);

    if (existing) {
      Object.assign(existing, { name, description, isActive: body['isActive'] !== false });
      return this.ok(existing);
    }

    const field = { id: `pv-field-${crypto.randomUUID()}`, name, description, isActive: true };
    this.data.fields.push(field);
    return this.ok(field, 201);
  }

  private saveCriterion(id: string | null, body: Record<string, unknown>) {
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const weight = Number(body['weight']);
    const sortOrder = Number(body['sortOrder']);
    if (!name || name.length > 200 || !(weight > 0) || !Number.isInteger(sortOrder))
      return this.error(400);

    if (id) {
      const existing = this.data.criteria.find((c) => c.id === id);
      if (!existing) return this.error(404);
      Object.assign(existing, { name, weight, sortOrder });
      return this.ok(existing);
    }

    const criterion = { id: `pv-crit-${crypto.randomUUID()}`, name, weight, sortOrder };
    this.data.criteria.push(criterion);
    return this.ok(criterion, 201);
  }

  private changeRole(id: string, role: unknown) {
    const user = this.data.users.find((u) => u.id === id);
    if (!user) return this.error(404);
    if (!STAFF_ROLES.includes(role as UserRole)) return this.error(400);
    user.role = role as UserRole;
    return this.ok(user);
  }

  private saveSettings(body: Record<string, unknown>) {
    const keys = [
      'trainingEndingNoticeDays',
      'lateEvaluationReminderDays',
      'pendingRequestAlertDays',
    ] as const;
    const values = keys.map((key) => Number(body[key]));
    if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 365)) return this.error(400);
    const [trainingEndingNoticeDays, lateEvaluationReminderDays, pendingRequestAlertDays] = values;
    this.data.settings = {
      trainingEndingNoticeDays,
      lateEvaluationReminderDays,
      pendingRequestAlertDays,
    };
    return this.ok(this.data.settings);
  }

  private saveCertificateTemplate(body: Record<string, unknown>) {
    const template = this.data.certificateTemplate;
    if (typeof body['settings'] !== 'object' || body['settings'] === null) return this.error(400);
    if ((body['version'] ?? null) !== template.version) return this.error(409);
    Object.assign(template, {
      settings: structuredClone(body['settings']),
      isDefault: false,
      version: String(Number(template.version ?? 0) + 1),
      updatedAt: new Date().toISOString(),
    });
    return this.ok(template);
  }

  private setCertificateImage(kind: string, file: unknown) {
    if (kind !== 'logo' && kind !== 'signature') return this.error(404);
    const template = this.data.certificateTemplate;
    template[kind] = file instanceof Blob ? { contentType: file.type } : null;
    template.version = String(Number(template.version ?? 0) + 1);
    template.isDefault = false;
    return this.ok(template);
  }

  /** Preview Mode has no assignments: the monthly report of a valid month (400 otherwise) is empty. */
  private monthlyReport(url: string) {
    const month = new URLSearchParams(url.split('?')[1] ?? '').get('month') ?? '';
    const match = /^([1-9]\d{3})-(0[1-9]|1[0-2])$/.exec(month);
    if (!match) return this.error(400);
    const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
    return this.ok({ month, monthStart: `${month}-01`, monthEnd: `${month}-${lastDay}`, rows: [] });
  }

  /** Preview Mode has no applications: every sample field with no applications (one field with `fieldId`). */
  private fieldsReport(url: string) {
    const fieldId = new URLSearchParams(url.split('?')[1] ?? '').get('fieldId') ?? '';
    const rows = [...this.data.fields]
      .filter((f) => !fieldId || f.id === fieldId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({ field: { id: f.id, name: f.name }, applications: 0, accepted: 0 }));
    return this.ok({ rows });
  }

  private ok(body: unknown, status = 200): Promise<MockResponse> {
    return delay({ status, body: structuredClone(body) });
  }

  private error(status: number): Promise<MockResponse> {
    return delay({ status, body: { status, title: 'Preview mock error' } });
  }
}

function delay(response: MockResponse): Promise<MockResponse> {
  return new Promise((resolve) => setTimeout(() => resolve(response), LATENCY_MS));
}
