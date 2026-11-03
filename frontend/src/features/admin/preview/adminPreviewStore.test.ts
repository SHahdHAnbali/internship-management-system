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
