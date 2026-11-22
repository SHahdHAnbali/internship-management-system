import { describe, expect, it } from 'vitest';
import { ADMIN_EXCLUDED_AUDIT_TABLES, ADMIN_VISIBLE_AUDIT_TABLES } from '../src/features/admin/auditDescriptions';
import { AUDIT_PAGE_SIZE, AUDITED_TABLES } from '../src/features/admin/auditLogRoutes';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, unique, withDb } from './helpers';
import { newField, submitApplication } from './seed';

/**
 * The Admin audit log viewer (owner decision AD-51): Admin only, read-only, safe metadata only. Every audit row here is
 * written by the database triggers for synthetic records made through the real endpoints.
 */
const api = createTestApi();

interface Entry {
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  operation: string;
  table: string;
  entityId: string | null;
}
interface Page {
  hasMore: boolean;
  /** The opaque Load More cursor (option A, owner 2026-11-22): null on the last page. */
  nextCursor: string | null;
  entries: Entry[];
}

const read = async (admin: TestClient, query = '') => {
  const response = await admin.get(`/api/admin/audit-logs${query}`);
  expect(response.status, query).toBe(200);
  return body<Page>(response);
};

/** Every page for a query, following the Load More cursor. */
async function readAll(admin: TestClient, query: string) {
  const pages: Page[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await read(admin, `${query}${cursor ? `&cursor=${cursor}` : ''}`);
    pages.push(page);
    expect(page.nextCursor === null, query).toBe(!page.hasMore);
    if (!page.hasMore) return pages;
    cursor = page.nextCursor;
  }
}

/** A problem body without its per-request trace id, to compare two refusals. */
const problem = async (response: Response) => {
  const { traceId: _traceId, ...rest } = await body<Record<string, unknown>>(response);
  return rest;
};

describe('audit log viewer: what it returns', () => {
  it('lists audit entries newest first with exactly the safe metadata fields', async () => {
    const admin = await signInStaff(api, 'Admin');
    const field = await newField(admin.client);
    await admin.client.put(`/api/admin/fields/${field.id}`, {
      name: unique('Renamed'),
      description: null,
      isActive: false,
    });

    const page = await read(admin.client, `?actorId=${admin.user.id}&table=fields`);
    expect(page.hasMore).toBe(false);
    expect(page.entries.map((e) => [e.operation, e.table, e.entityId, e.actorType, e.actorId])).toEqual([
      ['UPDATE', 'fields', field.id, 'Staff', admin.user.id],
      ['INSERT', 'fields', field.id, 'Staff', admin.user.id],
    ]);
    for (const entry of page.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        'actorCurrentRole',
        'actorId',
        'actorKnown',
        'actorName',
        'actorType',
        'description',
        'entityId',
        'occurredAt',
        'operation',
        'table',
      ]);
      expect(new Date(entry.occurredAt).toISOString()).toBe(entry.occurredAt);
    }
    expect(Object.keys(page).sort()).toEqual(['entries', 'hasMore', 'nextCursor']);
    expect(page.nextCursor).toBeNull();
    // The audit log's own sequential numbers never reach the Admin (option A): no value of the response is one.
    const numbers = await withDb((db) =>
      db.query<{ id: string }>("SELECT id::text FROM audit_logs WHERE actor_id = $1 AND table_name = 'fields'", [
        admin.user.id,
      ]),
    );
    const values = page.entries.flatMap((e) => Object.values(e).map(String));
    for (const { id } of numbers.rows) expect(values).not.toContain(id);
  });

  it('never returns stored values, sign-in secrets, session or code ids, or file storage keys', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const field = await newField(admin.client);
    const trainee = await signInTrainee(api); // a sign-in code (hashes) and a session
    const applicationId = await submitApplication(trainee.client, field.id, 'Synthetic Trainee'); // a CV in R2
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);

    const secrets = await withDb(async (db) => {
      const codes = await db.query<{ id: string; code_hash: string; token_hash: string }>(
        'SELECT id::text, code_hash, token_hash FROM trainee_sign_in_codes WHERE email = $1',
        [trainee.email],
      );
      const sessions = await db.query<{ id: string }>('SELECT id::text FROM user_sessions WHERE trainee_id = $1', [
        trainee.user.id,
      ]);
      const files = await db.query<{ storage_key: string; sha256: string }>(
        'SELECT storage_key, sha256 FROM application_attachments WHERE application_id = $1',
        [applicationId],
      );
      return {
        values: [
          ...codes.rows.flatMap((r) => [r.code_hash, r.token_hash]),
          ...files.rows.flatMap((r) => [r.storage_key, r.sha256]),
          trainee.email,
          '000-0000', // the synthetic phone number
          'cv.pdf',
        ],
        hiddenIds: [...codes.rows.map((r) => r.id), ...sessions.rows.map((r) => r.id)],
      };
    });
    expect(secrets.values.length).toBeGreaterThan(5);
    expect(secrets.hiddenIds.length).toBeGreaterThanOrEqual(2);

    // Every page that holds these records: the trainee's own writes, sign-in writes, and the whole sign-in tables.
    const queries = [
      `?actorId=${trainee.user.id}`,
      '?table=trainee_sign_in_codes',
      '?table=user_sessions',
      '?table=application_attachments',
      '?table=trainees',
      '?actorType=Anonymous',
    ];
    for (const query of queries) {
      const text = JSON.stringify(await read(admin.client, query));
      for (const value of secrets.values) expect(text, query).not.toContain(value);
      for (const id of secrets.hiddenIds) expect(text, query).not.toContain(id);
      expect(text, query).not.toMatch(/old_?values|new_?values|code_?hash|token_?hash|storage_?key/i);
    }

    // The trainee's name appears only as the name of who acted (actorName), never as a stored value.
    const own = await read(admin.client, `?actorId=${trainee.user.id}`);
    expect(own.entries.every((e) => (e as Entry & { actorName: string }).actorName === 'Synthetic Trainee')).toBe(true);

    // Rows of the sign-in tables are listed, without their record id.
    const codes = await read(admin.client, '?table=trainee_sign_in_codes');
    expect(codes.entries.length).toBeGreaterThan(0);
    expect(codes.entries.every((e) => e.entityId === null)).toBe(true);
    const sessions = await read(admin.client, '?table=user_sessions');
    expect(sessions.entries.every((e) => e.entityId === null)).toBe(true);
    // Other tables keep the record id (a business record's own id).
    const attachments = await read(admin.client, `?actorId=${trainee.user.id}&table=application_attachments`);
    expect(attachments.entries).toHaveLength(1);
    expect(attachments.entries[0]!.entityId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('knows every audited table, and offers all of them in its table filter except the final evaluation tables', async () => {
    const tables = await withDb((db) =>
      db.query<{ relname: string }>(
        "SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'audit_row_change' ORDER BY 1",
      ),
    );
    expect([...AUDITED_TABLES]).toEqual(tables.rows.map((r) => r.relname));
    // Owner decision of 2026-11-22 (AD-68 G4): evaluation events are recorded but never shown to the Admin.
    expect([...ADMIN_EXCLUDED_AUDIT_TABLES]).toEqual(['evaluations', 'evaluation_scores', 'evaluation_corrections']);
    expect([...ADMIN_VISIBLE_AUDIT_TABLES]).toEqual(
      AUDITED_TABLES.filter((t) => !(ADMIN_EXCLUDED_AUDIT_TABLES as readonly string[]).includes(t)),
    );
    expect(ADMIN_VISIBLE_AUDIT_TABLES).toContain('evaluation_criteria');

    const admin = await signInStaff(api, 'Admin');
    for (const table of ADMIN_VISIBLE_AUDIT_TABLES) {
      expect((await admin.client.get(`/api/admin/audit-logs?table=${table}`)).status, table).toBe(200);
    }
    // An excluded table is refused exactly like a table that does not exist: its existence is not revealed.
    const unknown = await problem(await admin.client.get('/api/admin/audit-logs?table=no_such_table'));
    expect(unknown).toMatchObject({ status: 400, code: 'validation.invalid' });
    for (const table of ADMIN_EXCLUDED_AUDIT_TABLES) {
      const response = await admin.client.get(`/api/admin/audit-logs?table=${table}&operation=INSERT`);
      expect(response.status, table).toBe(400);
      expect(await problem(response), table).toEqual(unknown);
    }
  });
});

describe('audit log viewer: filters and pages', () => {
  it('filters by operation, table, actor type, actor id and time range, alone and together', async () => {
    const admin = await signInStaff(api, 'Admin');
    const otherAdmin = await signInStaff(api, 'Admin');
    const started = new Date(Date.now() - 1000).toISOString();
    const field = await newField(admin.client);
    await admin.client.put(`/api/admin/fields/${field.id}`, {
      name: unique('Renamed'),
      description: 'x',
      isActive: true,
    });
    const criterion = await body<{ id: string }>(
      await admin.client.post('/api/admin/evaluation-criteria', {
        nameAr: unique('معيار'),
        nameEn: unique('Criterion'),
      }),
    );
    await newField(otherAdmin.client);
    const ended = new Date(Date.now() + 1000).toISOString();
    const mine = `actorId=${admin.user.id}`;
    // The Admin's own sign-in (account and session) is recorded as them too; these checks look at the records made here.
    const made = (p: Page) => p.entries.filter((e) => e.table !== 'employees' && e.table !== 'user_sessions');
    const shape = (p: Page) => made(p).map((e) => [e.operation, e.table, e.entityId]);

    expect(shape(await read(admin.client, `?${mine}`))).toEqual([
      ['INSERT', 'evaluation_criteria', criterion.id],
      ['UPDATE', 'fields', field.id],
      ['INSERT', 'fields', field.id],
    ]);
    expect(shape(await read(admin.client, `?${mine}&operation=UPDATE`))).toEqual([['UPDATE', 'fields', field.id]]);
    expect(shape(await read(admin.client, `?${mine}&operation=INSERT&table=fields`))).toEqual([
      ['INSERT', 'fields', field.id],
    ]);
    expect(shape(await read(admin.client, `?${mine}&table=evaluation_criteria`))).toEqual([
      ['INSERT', 'evaluation_criteria', criterion.id],
    ]);
    const staff = await read(admin.client, `?actorType=Staff&table=fields&from=${encodeURIComponent(started)}`);
    expect(staff.entries.every((e) => e.actorType === 'Staff' && e.table === 'fields')).toBe(true);
    expect(staff.entries.map((e) => e.actorId)).toEqual(expect.arrayContaining([admin.user.id, otherAdmin.user.id]));
    expect((await read(admin.client, `?actorType=Trainee&${mine}`)).entries).toEqual([]);

    // Time range: the start is included, the end excluded; offsets other than Z are understood.
    expect(
      made(await read(admin.client, `?${mine}&from=${encodeURIComponent(started)}&to=${encodeURIComponent(ended)}`)),
    ).toHaveLength(3);
    expect(made(await read(admin.client, `?${mine}&to=${encodeURIComponent(started)}`))).toEqual([]);
    expect((await read(admin.client, `?${mine}&from=${encodeURIComponent(ended)}`)).entries).toEqual([]);
    const offset = new Date(started).toISOString().replace('Z', '+00:00');
    expect(made(await read(admin.client, `?${mine}&from=${encodeURIComponent(offset)}`))).toHaveLength(3);

    // Nothing matches: an empty history for those filters.
    expect(await read(admin.client, `?actorId=${crypto.randomUUID()}`)).toEqual({
      hasMore: false,
      nextCursor: null,
      entries: [],
    });
  });

  it('pages newest first with Load More, without repeats or gaps', async () => {
    const admin = await signInStaff(api, 'Admin');
    const created = AUDIT_PAGE_SIZE + 7;
    for (let i = 0; i < created; i++) await newField(admin.client);

    const pages = await readAll(admin.client, `?actorId=${admin.user.id}&table=fields`);
    expect(pages.map((p) => p.entries.length)).toEqual([AUDIT_PAGE_SIZE, 7]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, false]);
    expect(pages[0]!.nextCursor).toMatch(/^c1\.[A-Za-z0-9_-]{71}$/);
    const records = pages.flatMap((p) => p.entries.map((e) => e.entityId));
    expect(new Set(records).size).toBe(created);

    // Exactly the records the database holds for this actor and table, in the audit log's own order (newest first).
    const expected = await withDb((db) =>
      db.query<{ entity_id: string }>(
        "SELECT entity_id::text FROM audit_logs WHERE actor_id = $1 AND table_name = 'fields' ORDER BY audit_logs.id DESC",
        [admin.user.id],
      ),
    );
    expect(records).toEqual(expected.rows.map((r) => r.entity_id));

    // A new record while paging does not shift the older pages.
    await newField(admin.client);
    const second = await read(admin.client, `?actorId=${admin.user.id}&table=fields&cursor=${pages[0]!.nextCursor}`);
    expect(second.entries).toEqual(pages[1]!.entries);
  });

  it('accepts a cursor only for the Admin and the filters it was issued to, with one fixed error', async () => {
    const admin = await signInStaff(api, 'Admin');
    const otherAdmin = await signInStaff(api, 'Admin');
    for (let i = 0; i < AUDIT_PAGE_SIZE + 1; i++) await newField(admin.client);
    const query = `?actorId=${admin.user.id}&table=fields`;
    const cursor = (await read(admin.client, query)).nextCursor!;
    expect((await admin.client.get(`/api/admin/audit-logs${query}&cursor=${cursor}`)).status).toBe(200);

    const refusal = await problem(await admin.client.get(`/api/admin/audit-logs${query}&cursor=garbage`));
    expect(refusal).toMatchObject({ status: 400, code: 'validation.invalid', detail: 'The cursor is not valid.' });
    const flipped = cursor.slice(0, 20) + (cursor[20] === 'A' ? 'B' : 'A') + cursor.slice(21);
    for (const [client, request] of [
      [otherAdmin.client, `${query}&cursor=${cursor}`], // another Admin
      [admin.client, `?actorId=${admin.user.id}&cursor=${cursor}`], // other filters
      [admin.client, `${query}&operation=INSERT&cursor=${cursor}`],
      [admin.client, `${query}&cursor=${flipped}`], // changed
      [admin.client, `${query}&cursor=${cursor}&cursor=${cursor}`], // repeated
      [admin.client, `${query}&cursor=`],
    ] as const) {
      const response = await client.get(`/api/admin/audit-logs${request}`);
      expect(response.status, request).toBe(400);
      expect(await problem(response), request).toEqual(refusal);
    }

    // The raw-number cursor of before 2026-11-22 is refused, whatever its value.
    for (const value of ['5', '102', '']) {
      const response = await admin.client.get(`/api/admin/audit-logs${query}&before=${value}`);
      expect(response.status, value).toBe(400);
      expect(await problem(response), value).toMatchObject({ code: 'validation.invalid' });
    }
  });

  it('refuses malformed filters without echoing them', async () => {
    const admin = await signInStaff(api, 'Admin');
    const marker = 'zz-not-allowed-zz';
    for (const query of [
      `?operation=DELETE`,
      `?operation=${marker}`,
      `?table=audit_logs`,
      `?table=${marker}`,
      `?actorType=Root`,
      `?actorId=${marker}`,
      `?from=${marker}`,
      '?from=2026-11-03',
      '?to=2026-11-03T10:00:00',
      '?from=2026-11-03T10:00:00Z&to=2026-11-03T10:00:00Z',
      '?from=2026-11-04T00:00:00Z&to=2026-11-03T00:00:00Z',
      '?before=0',
      '?before=102',
      `?before=${marker}`,
      `?cursor=${marker}`,
      `?cursor=c1.${marker}`,
    ]) {
      const response = await admin.client.get(`/api/admin/audit-logs${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.text(), query).not.toContain(marker);
    }
  });
});

describe('audit log viewer: access and read-only', () => {
  it('is for the Admin only', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const employee = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    expect((await admin.client.get('/api/admin/audit-logs')).status).toBe(200);
    for (const client of [hr.client, employee.client, trainee.client]) {
      expect((await client.get('/api/admin/audit-logs')).status).toBe(403);
    }
    expect((await api.client().get('/api/admin/audit-logs')).status).toBe(401);
  });

  it('changes nothing: no audit row is added or altered, and only GET exists', async () => {
    const admin = await signInStaff(api, 'Admin');
    await newField(admin.client);
    const snapshot = () =>
      withDb((db) =>
        db.query(
          'SELECT id, xmin::text, actor_type, operation, table_name, entity_id FROM audit_logs WHERE actor_id = $1 ORDER BY id',
          [admin.user.id],
        ),
      ).then((r) => r.rows);
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(0);
    await read(admin.client, `?actorId=${admin.user.id}`);
    await read(admin.client);
    expect(await snapshot()).toEqual(before);

    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await admin.client.request(method, '/api/admin/audit-logs', {})).status, method).toBe(405);
    }
  });
});
