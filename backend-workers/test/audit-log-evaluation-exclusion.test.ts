import { describe, expect, it } from 'vitest';
import { ADMIN_EXCLUDED_AUDIT_TABLES } from '../src/features/admin/auditDescriptions';
import { AUDIT_PAGE_SIZE } from '../src/features/admin/auditLogRoutes';
import { body, createTestApi, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';

/**
 * Owner decisions of 2026-11-22 (S2.1, AD-68 G4; option A): every write to the final evaluation tables is recorded in the
 * internal audit log, but the Admin viewer never returns those entries, with any filter or on any page, and pages stay
 * full; the viewer never returns an audit number either. The evaluation rows are written here directly by the database
 * owner (the Worker cannot write them in S2.1), as a synthetic staff actor, interleaved with visible writes.
 */
const api = createTestApi();

interface Page {
  hasMore: boolean;
  nextCursor: string | null;
  entries: { table: string; entityId: string | null; operation: string; actorId: string | null }[];
}

const read = async (admin: TestClient, query: string) => {
  const response = await admin.get(`/api/admin/audit-logs${query}`);
  expect(response.status, query).toBe(200);
  return body<Page>(response);
};

async function readAll(admin: TestClient, query: string) {
  const pages: Page[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await read(admin, `${query}${cursor ? `&cursor=${cursor}` : ''}`);
    pages.push(page);
    if (!page.hasMore) return pages;
    cursor = page.nextCursor;
  }
}

/** Runs the statements in one transaction, audited as staff actor `actorId` (as the Worker's transactions are). */
const asActor = (actorId: string, statements: string[]) =>
  withDb(async (db) => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('ims.actor_type', 'Staff', true), set_config('ims.actor_id', $1, true)", [
      actorId,
    ]);
    for (const sql of statements) await db.query(sql);
    await db.query('COMMIT');
  });

/** A training with an evaluation and some criteria (written as the database itself, not as any test actor). */
async function evaluationFixture(criteria = 0) {
  const [employee, trainee, field, application, assignment, evaluation] = [1, 2, 3, 4, 5, 6].map(() =>
    crypto.randomUUID(),
  ) as [string, string, string, string, string, string];
  const criterionIds = Array.from({ length: criteria }, () => crypto.randomUUID());
  await withDb((db) =>
    db.query(`
      INSERT INTO employees (id, full_name, email, role) VALUES ('${employee}', 'Synthetic Mentor', '${employee}@company.example', 'Employee');
      INSERT INTO trainees (id, email) VALUES ('${trainee}', '${trainee}@example.com');
      INSERT INTO fields (id, name, is_active) VALUES ('${field}', 'Field ${field}', true);
      INSERT INTO training_applications (id, trainee_id, field_id, status, available_from, available_to, hours,
                                         mandatory_for_university, submitted_at, decided_at, decided_by_id)
        VALUES ('${application}', '${trainee}', '${field}', 'Accepted', '2026-01-01', '2026-03-01', 120, false, now(), now(), '${employee}');
      INSERT INTO assignments (id, application_id, employee_id, start_date, end_date, status, created_at)
        VALUES ('${assignment}', '${application}', '${employee}', '2026-01-01', '2026-03-01', 'Completed', now());
      ${criterionIds.map((id) => `INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active) VALUES ('${id}', 'معيار', 'Criterion ${id}', true);`).join('\n')}
    `),
  );
  return { employee, application, assignment, evaluation, criterionIds };
}

const newEvaluation = (f: { evaluation: string; application: string; assignment: string }) =>
  `INSERT INTO evaluations (id, application_id, assignment_id, status, comment, created_at, updated_at)
     VALUES ('${f.evaluation}', '${f.application}', '${f.assignment}', 'Draft', 'Synthetic draft comment', now(), now())`;
const visibleWrite = () =>
  `INSERT INTO fields (id, name, is_active) VALUES (gen_random_uuid(), 'Synthetic field ' || gen_random_uuid(), true)`;

/** The visible (fields) records of an actor, newest first, as the database holds them. */
const visibleRecords = (actorId: string, extra = '') =>
  withDb((db) =>
    db.query<{ entity_id: string }>(
      `SELECT entity_id::text FROM audit_logs WHERE actor_id = $1 AND table_name <> ALL($2::text[]) ${extra} ORDER BY id DESC`,
      [actorId, ADMIN_EXCLUDED_AUDIT_TABLES],
    ),
  ).then((r) => r.rows.map((row) => row.entity_id));

describe('audit log viewer: final evaluation events', () => {
  it('records them internally, never returns them, and keeps pages full whatever the filter', async () => {
    const admin = await signInStaff(api, 'Admin');
    const actor = crypto.randomUUID();
    const fixture = await evaluationFixture(10);
    const started = new Date(Date.now() - 1000).toISOString();
    // 60 visible writes, with a hidden one after every second: the evaluation, then scores, updates and corrections.
    await asActor(actor, [visibleWrite(), newEvaluation(fixture)]);
    let scores = 0;
    for (let i = 1; i < 60; i++) {
      const hidden =
        i % 6 === 0 && scores < fixture.criterionIds.length
          ? `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES (gen_random_uuid(), '${fixture.evaluation}', '${fixture.criterionIds[scores++]}', 4)`
          : i % 6 === 2
            ? `UPDATE evaluations SET version = version + 1, comment = 'Synthetic comment ${i}' WHERE id = '${fixture.evaluation}'`
            : `INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at, reason) VALUES (gen_random_uuid(), '${fixture.evaluation}', '${fixture.employee}', now(), 'Synthetic reason ${i}')`;
      await asActor(actor, i % 2 === 0 ? [visibleWrite(), hidden] : [visibleWrite()]);
    }
    const ended = new Date(Date.now() + 1000).toISOString();

    // Recorded internally, all three tables, with their values.
    const internal = await withDb((db) =>
      db.query<{ table_name: string; operation: string; n: number }>(
        `SELECT table_name, operation, count(*)::int AS n FROM audit_logs
          WHERE actor_id = $1 AND table_name = ANY($2::text[]) AND new_values IS NOT NULL
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [actor, ADMIN_EXCLUDED_AUDIT_TABLES],
      ),
    );
    expect(internal.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['evaluation_corrections', 'evaluation_scores', 'evaluations']),
    );
    expect(internal.rows.reduce((sum, r) => sum + r.n, 0)).toBe(30); // the evaluation and 29 interleaved writes

    // Pages are full of visible entries: hidden ones never take a place.
    const all = await readAll(admin.client, `?actorId=${actor}`);
    expect(all.map((p) => p.entries.length)).toEqual([AUDIT_PAGE_SIZE, 10]);
    expect(all.map((p) => p.hasMore)).toEqual([true, false]);
    expect(all.flatMap((p) => p.entries.map((e) => e.entityId))).toEqual(await visibleRecords(actor));

    // The same with every filter combination that includes them.
    const range = `&from=${encodeURIComponent(started)}&to=${encodeURIComponent(ended)}`;
    for (const [query, extra] of [
      [`?actorId=${actor}&operation=INSERT`, "AND operation = 'INSERT'"],
      [`?actorId=${actor}&operation=UPDATE`, "AND operation = 'UPDATE'"],
      [`?actorType=Staff&actorId=${actor}`, ''],
      [`?actorId=${actor}${range}`, ''],
      [`?actorId=${actor}&operation=INSERT${range}`, "AND operation = 'INSERT'"],
    ] as const) {
      const pages = await readAll(admin.client, query);
      const entries = pages.flatMap((p) => p.entries);
      expect(
        entries.filter((e) => (ADMIN_EXCLUDED_AUDIT_TABLES as readonly string[]).includes(e.table)),
        query,
      ).toEqual([]);
      expect(
        entries.map((e) => e.entityId),
        query,
      ).toEqual(await visibleRecords(actor, extra));
    }
    // Only evaluation writes were UPDATEs here: nothing at all is shown for them.
    expect(await read(admin.client, `?actorId=${actor}&operation=UPDATE`)).toEqual({
      hasMore: false,
      nextCursor: null,
      entries: [],
    });
  });

  it('says "no more" when the only older or newer entries are evaluation events', async () => {
    const admin = await signInStaff(api, 'Admin');
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    const first = await evaluationFixture();
    const second = await evaluationFixture();
    const corrections = (f: typeof first) =>
      Array.from(
        { length: 5 },
        () =>
          `INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at) VALUES (gen_random_uuid(), '${f.evaluation}', '${f.employee}', now())`,
      );
    // Hidden entries older than the 50 visible ones, then hidden entries newer than them.
    await asActor(older, [newEvaluation(first), ...corrections(first)]);
    for (let i = 0; i < AUDIT_PAGE_SIZE; i++) await asActor(older, [visibleWrite()]);
    for (let i = 0; i < AUDIT_PAGE_SIZE; i++) await asActor(newer, [visibleWrite()]);
    await asActor(newer, [newEvaluation(second), ...corrections(second)]);

    for (const actor of [older, newer]) {
      const page = await read(admin.client, `?actorId=${actor}`);
      expect(page.entries).toHaveLength(AUDIT_PAGE_SIZE);
      expect([page.hasMore, page.nextCursor]).toEqual([false, null]);
    }
  });

  it('keeps the evaluation criteria and every other table visible', async () => {
    const admin = await signInStaff(api, 'Admin');
    const actor = crypto.randomUUID();
    const criterion = crypto.randomUUID();
    await asActor(actor, [
      `INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active) VALUES ('${criterion}', 'معيار', 'Visible ${criterion}', true)`,
      visibleWrite(),
    ]);

    const page = await read(admin.client, `?actorId=${actor}`);
    expect(page.entries.map((e) => e.table).sort()).toEqual(['evaluation_criteria', 'fields']);
    expect((await read(admin.client, `?actorId=${actor}&table=evaluation_criteria`)).entries).toMatchObject([
      { table: 'evaluation_criteria', entityId: criterion, operation: 'INSERT' },
    ]);
  });

  it('never returns an audit number, in entries, cursors or anywhere in the response', async () => {
    const admin = await signInStaff(api, 'Admin');
    const actor = crypto.randomUUID();
    const fixture = await evaluationFixture();
    await asActor(actor, [newEvaluation(fixture)]);
    for (let i = 0; i < AUDIT_PAGE_SIZE + 5; i++) await asActor(actor, [visibleWrite()]);
    const numbers = await withDb((db) =>
      db.query<{ id: string }>('SELECT id::text FROM audit_logs WHERE actor_id = $1', [actor]),
    ).then((r) => r.rows.map((row) => row.id));
    expect(numbers.length).toBe(AUDIT_PAGE_SIZE + 6);

    const pages = await readAll(admin.client, `?actorId=${actor}`);
    const keys = new Set<string>();
    const values: unknown[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          keys.add(key);
          walk(value);
        }
      } else values.push(node);
    };
    pages.forEach(walk);
    expect([...keys].filter((k) => /^(id|auditId|before|position|sequence)$/i.test(k))).toEqual([]);
    for (const number of numbers) {
      expect(values.map(String), number).not.toContain(number);
      for (const page of pages) expect(page.nextCursor ?? '', number).not.toContain(number);
    }
  });

  it('is still for the Admin only, even with a valid cursor', async () => {
    const admin = await signInStaff(api, 'Admin');
    const actor = crypto.randomUUID();
    for (let i = 0; i < AUDIT_PAGE_SIZE + 1; i++) await asActor(actor, [visibleWrite()]);
    const cursor = (await read(admin.client, `?actorId=${actor}`)).nextCursor!;
    const path = `/api/admin/audit-logs?actorId=${actor}&cursor=${cursor}`;

    for (const role of ['HR', 'Employee'] as const) {
      expect((await (await signInStaff(api, role)).client.get(path)).status, role).toBe(403);
    }
    expect((await (await signInTrainee(api)).client.get(path)).status).toBe(403);
    expect((await api.client().get(path)).status).toBe(401);
  });

  it('changes nothing in the internal audit log when it is read', async () => {
    const admin = await signInStaff(api, 'Admin');
    const actor = crypto.randomUUID();
    const fixture = await evaluationFixture();
    await asActor(actor, [visibleWrite(), newEvaluation(fixture), visibleWrite()]);
    const fingerprint = () =>
      withDb((db) =>
        db.query<{ n: number; h: string }>(
          "SELECT count(*)::int AS n, md5(string_agg(a::text, '|' ORDER BY id)) AS h FROM audit_logs a WHERE actor_id = $1",
          [actor],
        ),
      ).then((r) => r.rows[0]);
    const before = await fingerprint();

    await readAll(admin.client, `?actorId=${actor}`);
    await read(admin.client, `?actorId=${actor}&table=fields`);
    expect((await admin.client.get(`/api/admin/audit-logs?actorId=${actor}&table=evaluations`)).status).toBe(400);

    expect(await fingerprint()).toEqual(before);
    expect(before!.n).toBe(3);
  });
});
