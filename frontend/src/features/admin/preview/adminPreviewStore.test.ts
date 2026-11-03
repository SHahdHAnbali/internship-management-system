import { AdminPreviewStore } from './adminPreviewStore';

describe('AdminPreviewStore (Admin Preview Mode mock)', () => {
  let store: AdminPreviewStore;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    store = new AdminPreviewStore();
  });
  afterEach(() => vi.useRealTimers());

  const send = (method: string, url: string, body: unknown = null) =>
    store.handle(method, url, body)!;

  it('ignores requests outside the Admin API', () => {
    expect(store.handle('GET', '/api/auth/me', null)).toBeNull();
    expect(store.handle('GET', '/i18n/ar.json', null)).toBeNull();
  });

  it('serves realistic sample data for every Admin page', async () => {
    expect(((await send('GET', '/api/admin/fields')).body as unknown[]).length).toBeGreaterThan(0);
    expect(((await send('GET', '/api/admin/users')).body as unknown[]).length).toBeGreaterThan(0);
    expect((await send('GET', '/api/admin/settings/notifications')).body).toEqual({
      trainingEndingNoticeDays: 7,
      lateEvaluationReminderDays: 3,
      pendingRequestAlertDays: 5,
    });
  });

  it('has no assignments, so the monthly report is empty (and a bad month is refused like the API)', async () => {
    expect((await send('GET', '/api/admin/reports/monthly?month=2031-02')).body).toEqual({
      month: '2031-02',
      monthStart: '2031-02-01',
      monthEnd: '2031-02-28',
      rows: [],
    });
    expect((await send('GET', '/api/admin/reports/monthly/filters')).body).toEqual({
      fields: [],
      employees: [],
    });
    expect((await send('GET', '/api/admin/reports/monthly?month=2031-13')).status).toBe(400);
    expect((await send('GET', '/api/admin/reports/other')).status).toBe(404);
  });

  it('lists the sample fields in the fields report with no applications (Preview Mode has none)', async () => {
    const fields = (await send('GET', '/api/admin/fields')).body as { id: string; name: string }[];
    const report = (await send('GET', '/api/admin/reports/fields')).body as {
      rows: { field: { id: string }; applications: number; accepted: number }[];
    };
    expect(report.rows.map((r) => r.field.id).sort()).toEqual(fields.map((f) => f.id).sort());
    expect(report.rows.every((r) => r.applications === 0 && r.accepted === 0)).toBe(true);
    const one = (await send('GET', `/api/admin/reports/fields?fieldId=${fields[0]!.id}`)).body as {
      rows: unknown[];
    };
    expect(one.rows).toHaveLength(1);
  });

  it('validates like the real API and forgets everything on reset', async () => {
    expect((await send('POST', '/api/admin/fields', { name: 'Mobile' })).status).toBe(201);
    expect((await send('POST', '/api/admin/fields', { name: 'mobile' })).status).toBe(409);
    expect(
      (
        await send('POST', '/api/admin/evaluation-criteria', {
          name: 'Zero',
          weight: 0,
          sortOrder: 1,
        })
      ).status,
    ).toBe(400);
    expect((await send('PUT', '/api/admin/users/pv-user-2/role', { role: 'Trainee' })).status).toBe(
      400,
    );
    store.reset();
    expect(
      ((await send('GET', '/api/admin/fields')).body as { name: string }[]).some(
        (f) => f.name === 'Mobile',
      ),
    ).toBe(false);
  });
});
