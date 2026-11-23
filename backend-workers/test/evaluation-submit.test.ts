import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../src/db';
import { ConcurrencyError, StateConflictError } from '../src/domain/errors';
import { calendarDate } from '../src/domain/training';
import type { EvaluableTraining } from '../src/features/evaluation/access';
import { submitEvaluation } from '../src/features/evaluation/submit';
import { body, setRole, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-database';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Submitting the final evaluation, stage S2.3 (R27; AD-66, AD-68 G2/G3/G4/G8, AD-70, owner decisions of 2026-11-23,
 * AD-71): `POST /api/evaluations/:id/submit` with the draft's revision and the criteria fingerprint, and the submitted
 * detail. A submission needs a score for every active criterion and refuses a changed criteria set, and the active
 * criteria are shared by every test file, so this file runs on a database of its own in the disposable container
 * (alternative B, test/isolated-database.ts): its criteria are exactly the ones its tests create. Its tests run in order.
 * The concurrency tests use independent PostgreSQL connections and wait for an observed lock wait, never for time.
 */
let isolated: IsolatedDatabase;
let api: TestApi;
let admin: { client: TestClient; user: { id: string }; email: string };

beforeAll(async () => {
  isolated = await createIsolatedDatabase();
  api = isolated.api();
  admin = await signInStaff(api, 'Admin');
});

const db = <T>(work: (client: pg.Client) => Promise<T>) => withDb(work, isolated.ownerUrl);
const today = () => calendarDate(new Date());
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface Criterion {
  id: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
}
interface Detail {
  status: string;
  capacities: string[];
  commentOnly: boolean;
  criteria: Criterion[];
  revision?: number;
  criteriaVersion?: string;
  draft?: unknown;
  submission?: {
    submittedAt: string;
    submittedBy: { name: string };
    comment: string;
    hiringRecommendation: string;
    scores: Record<string, number>;
    grade: string | null;
  };
}

/** Only `count` active criteria, this test's own: every other active criterion is deactivated first. */
async function freshCriteria(count: number): Promise<Criterion[]> {
  const active = await db((c) =>
    c.query<Criterion>(
      'SELECT id, name_ar AS "nameAr", name_en AS "nameEn", sort_order AS "sortOrder" FROM evaluation_criteria WHERE is_active',
    ),
  );
  for (const c of active.rows) await setActive(c, false);
  const created: Criterion[] = [];
  for (let i = 0; i < count; i++) created.push(await newCriterion());
  return created;
}
async function newCriterion(nameEn = `Criterion ${crypto.randomUUID().slice(0, 8)}`): Promise<Criterion> {
  const response = await admin.client.post('/api/admin/evaluation-criteria', { nameAr: `معيار ${nameEn}`, nameEn });
  expect(response.status).toBe(201);
  return body<Criterion>(response);
}
async function setActive(c: Criterion, isActive: boolean, names: Partial<Criterion> = {}) {
  const response = await admin.client.put(`/api/admin/evaluation-criteria/${c.id}`, {
    nameAr: names.nameAr ?? c.nameAr,
    nameEn: names.nameEn ?? c.nameEn,
    isActive,
  });
  expect(response.status).toBe(200);
}

/** An ended training (EndedEarly today): responsible HR = the accepting HR, final mentor = an Employee. */
async function endedTraining() {
  const hr = await signInStaff(api, 'HR');
  const mentor = await signInStaff(api, 'Employee');
  const trainee = await signInTrainee(api);
  const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Submit Trainee');
  expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  const assignmentId = await seedAssignment(
    applicationId,
    mentor.user.id,
    addDays(today(), -30),
    addDays(today(), 30),
    'Active',
    isolated.ownerUrl,
  );
  const ended = await hr.client.post(`/api/hr/assignments/${assignmentId}/complete`, {
    endDate: today(),
    reason: 'Synthetic early end',
  });
  expect(ended.status).toBe(200);
  return { hr, mentor, trainee, applicationId, assignmentId };
}

const read = async (client: TestClient, applicationId: string) => {
  const response = await client.get(`/api/evaluations/${applicationId}`);
  expect(response.status).toBe(200);
  return body<Detail>(response);
};
const save = (client: TestClient, applicationId: string, draft: Record<string, unknown>) =>
  client.put(`/api/evaluations/${applicationId}/draft`, {
    revision: 0,
    comment: null,
    hiringRecommendation: null,
    scores: {},
    ...draft,
  });
const submit = (client: TestClient, applicationId: string, request: Record<string, unknown>) =>
  client.post(`/api/evaluations/${applicationId}/submit`, request);
const code = async (response: Response) => [response.status, (await body<{ code?: string }>(response)).code];

/** Saves a complete draft as `client` and returns what the evaluator then sees: its revision and criteria version. */
async function completeDraft(
  client: TestClient,
  applicationId: string,
  scores: Record<string, number>,
  extra: Record<string, unknown> = {},
) {
  const current = await read(client, applicationId);
  const response = await save(client, applicationId, {
    revision: current.revision,
    comment: 'A complete evaluation',
    hiringRecommendation: 'Yes',
    scores,
    ...extra,
  });
  expect(response.status).toBe(200);
  const saved = await body<Detail>(response);
  return { revision: saved.revision!, criteriaVersion: saved.criteriaVersion! };
}

/** The stored evaluation, to prove what changed (or that nothing did). */
const stored = (applicationId: string) =>
  db((c) =>
    c.query<{
      status: string;
      version: number;
      submitted_by_id: string | null;
      submitted_at: Date | null;
      frozen: { criterion: string; score: number; nameEn: string; order: number }[] | null;
      unfrozen: number;
    }>(
      `SELECT e.status, e.version, e.submitted_by_id, e.submitted_at,
              (SELECT json_agg(json_build_object('criterion', s.criterion_id, 'score', s.score, 'nameEn', s.frozen_name_en,
                                                 'order', s.frozen_sort_order) ORDER BY s.frozen_sort_order)
                 FROM evaluation_scores s WHERE s.evaluation_id = e.id AND s.frozen_sort_order IS NOT NULL) AS frozen,
              (SELECT count(*)::int FROM evaluation_scores s WHERE s.evaluation_id = e.id AND s.frozen_sort_order IS NULL) AS unfrozen
         FROM evaluations e WHERE e.application_id = $1`,
      [applicationId],
    ),
  ).then((r) => r.rows[0]);

// ── Lock observation (this database is this file's alone, and its tests run in order) ─────────────────────────────

/** Resolves once `count` sessions of this database wait for a lock; fails after 20 s (a missing wait, never a timing). */
async function lockWaits(count: number) {
  for (let i = 0; i < 1000; i++) {
    const n = await db((c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      ),
    ).then((r) => r.rows[0]!.n);
    if (n >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Expected ${count} session(s) waiting for a lock.`);
}

/**
 * Resolves once a submission holds the criteria table's SHARE lock and waits for another lock in the statement that
 * starts with `waitingIn` (it is paused there, past its rights check and its evaluation lock).
 */
async function submissionPausedHoldingCriteriaLock(waitingIn: string) {
  for (let i = 0; i < 1000; i++) {
    const n = await db((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.relation = 'evaluation_criteria'::regclass AND l.mode = 'ShareLock' AND l.granted
            AND a.wait_event_type = 'Lock' AND a.datname = current_database() AND starts_with(ltrim(a.query), $1)`,
        [waitingIn],
      ),
    ).then((r) => r.rows[0]!.n);
    if (n === 1) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Expected a submission holding the criteria lock and waiting in: ${waitingIn}`);
}

/** An owner transaction that holds whatever `sql` locks until `end` (COMMIT or ROLLBACK); always closed in `finally`. */
async function holding<T>(
  sql: [string, unknown[]][],
  work: (end: (how: 'COMMIT' | 'ROLLBACK') => Promise<void>) => Promise<T>,
) {
  const client = new pg.Client({ connectionString: isolated.ownerUrl });
  client.on('error', () => undefined);
  await client.connect();
  let open = true;
  try {
    await client.query('BEGIN');
    for (const [text, params] of sql) await client.query(text, params);
    return await work(async (how) => {
      if (open) {
        open = false;
        await client.query(how);
      }
    });
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
const lockEvaluation = (applicationId: string): [string, unknown[]] => [
  'SELECT id FROM evaluations WHERE application_id = $1 FOR UPDATE',
  [applicationId],
];
/**
 * Pausing a submission after its criteria lock (owner decision of 2026-11-23, S2.2/S2.3 rights hardening). Its rights
 * are now decided first, under a FOR SHARE lock on the submitter's staff row, so that row can no longer pause it at the
 * end. Instead:
 *  - with frozen scores: the training's score rows (FOR UPDATE): the submission waits at its snapshot UPDATE;
 *  - with no active criterion (no score row): SHARE on the evaluations table, taken before the submission starts. Its
 *    row lock (FOR UPDATE needs ROW SHARE) and the criteria lock pass; its final UPDATE (ROW EXCLUSIVE) waits. Only
 *    writes to evaluations wait, in this file's own database, during that one test; the holder waits for nothing.
 */
const lockScores = (applicationId: string): [string, unknown[]] => [
  `SELECT s.id FROM evaluation_scores s JOIN evaluations e ON e.id = s.evaluation_id
    WHERE e.application_id = $1 FOR UPDATE OF s`,
  [applicationId],
];
const lockEvaluationWrites: [string, unknown[]] = ['LOCK TABLE evaluations IN SHARE MODE', []];
const SNAPSHOT_UPDATE = 'UPDATE evaluation_scores s';
const SUBMISSION_UPDATE = 'UPDATE evaluations';

// ── The submission ────────────────────────────────────────────────────────────────────────────────────────────────

describe('final evaluation submission (S2.3): a successful submission through HTTP', () => {
  it('submits the saved draft: frozen names, order and scores, the verbal grade, the submitter’s name and time', async () => {
    const [c1, c2, c3] = await freshCriteria(3);
    const t = await endedTraining();
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 5, [c2!.id]: 4, [c3!.id]: 4 });
    const before = Date.now();
    const response = await submit(t.mentor.client, t.applicationId, seen);
    const after = Date.now();
    expect(response.status).toBe(200);
    const d = await body<Detail>(response);

    expect(Object.keys(d).sort()).toEqual(
      [
        'applicationId',
        'capacities',
        'commentOnly',
        'criteria',
        'endDate',
        'endStatus',
        'fieldName',
        'startDate',
        'status',
        'submission',
        'traineeName',
      ].sort(),
    );
    expect(d.status).toBe('Submitted');
    expect(d.criteria).toEqual(
      [c1, c2, c3].map((c) => ({ id: c!.id, nameAr: c!.nameAr, nameEn: c!.nameEn, sortOrder: c!.sortOrder })),
    );
    const name = await db((c) =>
      c.query<{ full_name: string }>('SELECT full_name FROM employees WHERE id = $1', [t.mentor.user.id]),
    ).then((r) => r.rows[0]!.full_name);
    expect(d.submission).toMatchObject({
      submittedBy: { name },
      comment: 'A complete evaluation',
      hiringRecommendation: 'Yes',
      scores: { [c1!.id]: 5, [c2!.id]: 4, [c3!.id]: 4 },
      grade: 'VeryGood', // 13 / 3: never a number in any response
    });
    const submittedAt = new Date(d.submission!.submittedAt).getTime();
    expect(submittedAt >= before && submittedAt <= after).toBe(true);

    const row = (await stored(t.applicationId))!;
    expect(row).toMatchObject({
      status: 'Submitted',
      version: seen.revision + 1,
      submitted_by_id: t.mentor.user.id,
      unfrozen: 0,
    });
    expect(row.submitted_at!.toISOString()).toBe(d.submission!.submittedAt);
    expect(row.frozen).toEqual(
      [c1, c2, c3].map((c, i) => ({ criterion: c!.id, score: [5, 4, 4][i], nameEn: c!.nameEn, order: c!.sortOrder })),
    );

    // Read-only from now on, the same for both evaluators; the list shows the status, never a grade.
    expect(await read(t.mentor.client, t.applicationId)).toEqual(d);
    const asHr = await read(t.hr.client, t.applicationId);
    expect({ ...asHr, capacities: d.capacities }).toEqual(d); // the same evaluation, in the HR user's own capacity
    expect(asHr.capacities).toEqual(['ResponsibleHr']);
    expect(
      await code(await save(t.mentor.client, t.applicationId, { revision: seen.revision + 1, comment: 'Late' })),
    ).toEqual([409, 'evaluation.already_submitted']);
    expect(await code(await submit(t.hr.client, t.applicationId, seen))).toEqual([409, 'evaluation.already_submitted']);
    const listed = (await body<Record<string, unknown>[]>(await t.hr.client.get('/api/evaluations'))).find(
      (i) => i.applicationId === t.applicationId,
    )!;
    expect(listed.status).toBe('Submitted');
    expect(Object.keys(listed)).not.toContain('grade');
    expect(JSON.stringify(d)).not.toMatch(/"(mean|average|total|sum|count|revision|criteriaVersion|draft)"/);
  });

  it('is audited as the submitter, invisible in the Admin audit log viewer, without any audit number', async () => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    const seen = await completeDraft(t.hr.client, t.applicationId, { [c1!.id]: 3 });
    expect((await submit(t.hr.client, t.applicationId, seen)).status).toBe(200);

    const audit = await db((c) =>
      c.query<{
        table_name: string;
        actor_type: string;
        actor_id: string;
        status: string | null;
        frozen: string | null;
      }>(
        `SELECT a.table_name, a.actor_type, a.actor_id::text, a.new_values ->> 'status' AS status,
                a.new_values ->> 'frozen_name_en' AS frozen
           FROM audit_logs a JOIN evaluations e ON e.application_id = $1
          WHERE a.operation = 'UPDATE'
            AND ((a.table_name = 'evaluations' AND a.entity_id = e.id::text AND a.new_values ->> 'status' = 'Submitted')
              OR (a.table_name = 'evaluation_scores' AND a.new_values ->> 'frozen_name_en' IS NOT NULL
                  AND a.entity_id IN (SELECT s.id::text FROM evaluation_scores s WHERE s.evaluation_id = e.id)))
          ORDER BY a.table_name`,
        [t.applicationId],
      ),
    );
    expect(audit.rows).toEqual([
      {
        table_name: 'evaluation_scores',
        actor_type: 'Staff',
        actor_id: t.hr.user.id,
        status: null,
        frozen: c1!.nameEn,
      },
      { table_name: 'evaluations', actor_type: 'Staff', actor_id: t.hr.user.id, status: 'Submitted', frozen: null },
    ]);
    const viewer = await body<{ entries: Record<string, unknown>[] }>(
      await admin.client.get(`/api/admin/audit-logs?actorId=${t.hr.user.id}`),
    );
    expect(viewer.entries.length).toBeGreaterThan(0); // the HR user's other writes are there
    expect(
      viewer.entries.filter((e) =>
        ['evaluations', 'evaluation_scores', 'evaluation_corrections'].includes(e.table as string),
      ),
    ).toEqual([]);
    for (const e of viewer.entries) expect(Object.keys(e)).not.toContain('id');
    expect((await admin.client.get('/api/admin/audit-logs?table=evaluations')).status).toBe(400);
  });

  it('a comment-only evaluation (no active criterion) needs the comment and the recommendation; it has no grade', async () => {
    await freshCriteria(0);
    const t = await endedTraining();
    const first = await read(t.mentor.client, t.applicationId);
    expect([first.commentOnly, first.criteria]).toEqual([true, []]);
    const saved = await body<Detail>(await save(t.mentor.client, t.applicationId, { comment: 'Comment only' }));
    expect(
      await code(
        await submit(t.mentor.client, t.applicationId, {
          revision: saved.revision,
          criteriaVersion: saved.criteriaVersion,
        }),
      ),
    ).toEqual([409, 'evaluation.incomplete']);
    const seen = await completeDraft(t.mentor.client, t.applicationId, {}, { comment: 'Comment only' });
    const d = await body<Detail>(await submit(t.mentor.client, t.applicationId, seen));
    expect(d).toMatchObject({ status: 'Submitted', commentOnly: true, criteria: [] });
    expect(d.submission).toMatchObject({
      comment: 'Comment only',
      hiringRecommendation: 'Yes',
      scores: {},
      grade: null,
    });
  });

  it('a criterion deactivated before submission keeps its saved score, unfrozen, outside the submission and the grade', async () => {
    const [kept, dropped] = await freshCriteria(2);
    const t = await endedTraining();
    await completeDraft(t.mentor.client, t.applicationId, { [kept!.id]: 2, [dropped!.id]: 5 });
    await setActive(dropped!, false);
    const current = await read(t.mentor.client, t.applicationId);
    const d = await body<Detail>(
      await submit(t.mentor.client, t.applicationId, {
        revision: current.revision,
        criteriaVersion: current.criteriaVersion,
      }),
    );
    expect(d.criteria.map((c) => c.id)).toEqual([kept!.id]);
    expect(d.submission).toMatchObject({ scores: { [kept!.id]: 2 }, grade: 'Pass' }); // 5 would have made it Good
    const row = (await stored(t.applicationId))!;
    expect([row.frozen!.map((f) => f.criterion), row.unfrozen]).toEqual([[kept!.id], 1]);
  });
});

describe('final evaluation submission (S2.3): records made before the UUID v7 fix', () => {
  it('an evaluation and scores with UUID v4 ids (S2.2 before the fix) are read, saved and submitted normally, ids kept', async () => {
    const [c1, c2] = await freshCriteria(2);
    const t = await endedTraining();
    const v4 = { evaluation: crypto.randomUUID(), s1: crypto.randomUUID(), s2: crypto.randomUUID() };
    expect(v4.evaluation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    await db(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('ims.actor_type', 'System', true)");
      await c.query(
        `INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'Draft', now(), now())`,
        [v4.evaluation, t.applicationId, t.assignmentId],
      );
      await c.query(
        `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score) VALUES ($1, $3, $4, 2), ($2, $3, $5, 3)`,
        [v4.s1, v4.s2, v4.evaluation, c1!.id, c2!.id],
      );
      await c.query('COMMIT');
    });
    const opened = await read(t.mentor.client, t.applicationId);
    expect(opened.draft).toMatchObject({ scores: { [c1!.id]: 2, [c2!.id]: 3 } });
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4, [c2!.id]: 5 });
    const d = await body<Detail>(await submit(t.mentor.client, t.applicationId, seen));
    expect(d.submission).toMatchObject({ scores: { [c1!.id]: 4, [c2!.id]: 5 }, grade: 'Excellent' });
    const kept = await db((c) =>
      c.query<{ id: string }>(
        'SELECT id::text FROM evaluations WHERE application_id = $1 UNION ALL SELECT id::text FROM evaluation_scores WHERE evaluation_id = $2 ORDER BY 1',
        [t.applicationId, v4.evaluation],
      ),
    ).then((r) => r.rows.map((x) => x.id));
    expect(kept.sort()).toEqual([v4.evaluation, v4.s1, v4.s2].sort()); // never rewritten
  });
});

describe('final evaluation submission (S2.3): who may submit, and the refusals', () => {
  it('401 signed out, 403 Admin (even as the final mentor) and trainee, 404 for others like a missing training', async () => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4 });
    const missing = await submit(t.hr.client, crypto.randomUUID(), seen);
    expect(missing.status).toBe(404);
    const { traceId: _missing, ...notFound } = await body<Record<string, unknown>>(missing);

    expect((await submit(api.client(), t.applicationId, seen)).status).toBe(401);
    for (const client of [admin.client, t.trainee.client])
      expect((await submit(client, t.applicationId, seen)).status).toBe(403);
    for (const client of [(await signInStaff(api, 'HR')).client, (await signInStaff(api, 'Employee')).client]) {
      const response = await submit(client, t.applicationId, seen);
      expect(response.status).toBe(404);
      const { traceId: _other, ...rest } = await body<Record<string, unknown>>(response);
      expect(rest).toEqual(notFound);
    }
    // Checked at submission time: the mentor, who could open it, is an Admin now.
    await setRole(t.mentor.email, 'Admin', isolated.ownerUrl);
    expect((await submit(t.mentor.client, t.applicationId, seen)).status).toBe(403);
    expect((await stored(t.applicationId))!.status).toBe('Draft');
  });

  it('a former mentor (transferred away), an HR user who lost the role or was replaced cannot submit; the new evaluators can', async () => {
    const [c1] = await freshCriteria(1);
    const hr = await signInStaff(api, 'HR');
    const previous = await signInStaff(api, 'Employee');
    const next = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Moved Trainee');
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    const first = await seedAssignment(
      applicationId,
      previous.user.id,
      addDays(today(), -30),
      addDays(today(), 30),
      'Active',
      isolated.ownerUrl,
    );
    const moved = await hr.client.post(`/api/hr/assignments/${first}/transfer`, {
      employeeId: next.user.id,
      transferDate: today(),
      reason: 'Synthetic',
    });
    expect(moved.status).toBe(200);
    const latest = await db((c) =>
      c.query<{ id: string }>("SELECT id FROM assignments WHERE application_id = $1 AND status = 'Active'", [
        applicationId,
      ]),
    );
    expect(
      (
        await hr.client.post(`/api/hr/assignments/${latest.rows[0]!.id}/complete`, {
          endDate: today(),
          reason: 'Synthetic',
        })
      ).status,
    ).toBe(200);

    const seen = await completeDraft(next.client, applicationId, { [c1!.id]: 4 });
    expect((await submit(previous.client, applicationId, seen)).status).toBe(404);
    await setRole(hr.email, 'Employee', isolated.ownerUrl);
    expect((await submit(hr.client, applicationId, seen)).status).toBe(404);
    await setRole(hr.email, 'HR', isolated.ownerUrl);
    const replacement = await signInStaff(api, 'HR');
    expect(
      (
        await admin.client.put(`/api/admin/accepted-trainees/${applicationId}/responsible-hr`, {
          hrId: replacement.user.id,
        })
      ).status,
    ).toBe(200);
    expect((await submit(hr.client, applicationId, seen)).status).toBe(404);
    expect((await stored(applicationId))!.status).toBe('Draft');
    const d = await body<Detail>(await submit(replacement.client, applicationId, seen));
    expect(d.submission!.submittedBy.name).toBe(
      await db((c) =>
        c.query<{ full_name: string }>('SELECT full_name FROM employees WHERE id = $1', [replacement.user.id]),
      ).then((r) => r.rows[0]!.full_name),
    );
  });

  it('a training not ended cannot be submitted: 409 evaluation.not_available', async () => {
    await freshCriteria(0);
    const hr = await signInStaff(api, 'HR');
    const mentor = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    await seedAssignment(
      applicationId,
      mentor.user.id,
      addDays(today(), -30),
      addDays(today(), 30),
      'Active',
      isolated.ownerUrl,
    );
    expect(
      await code(await submit(mentor.client, applicationId, { revision: 0, criteriaVersion: `c1.${'A'.repeat(43)}` })),
    ).toEqual([409, 'evaluation.not_available']);
  });

  it('409 evaluation.incomplete without a saved draft, or with a comment, recommendation or active score missing; nothing changes', async () => {
    const [c1, c2] = await freshCriteria(2);
    const t = await endedTraining();
    const none = await read(t.mentor.client, t.applicationId);
    expect(none.status).toBe('NotStarted');
    expect(
      await code(
        await submit(t.mentor.client, t.applicationId, { revision: 0, criteriaVersion: none.criteriaVersion }),
      ),
    ).toEqual([409, 'evaluation.incomplete']);
    expect(await stored(t.applicationId)).toBeUndefined(); // still nothing: a submission never creates a draft

    let revision = 0;
    // The missing score first: a saved score is never cleared (S2.2), so c2 stays scored once it is.
    for (const draft of [
      { comment: 'Text', hiringRecommendation: 'Yes', scores: { [c1!.id]: 3 } },
      { comment: null, hiringRecommendation: 'Yes', scores: { [c1!.id]: 3, [c2!.id]: 3 } },
      { comment: 'Text', hiringRecommendation: null, scores: { [c1!.id]: 3, [c2!.id]: 3 } },
    ]) {
      const saved = await body<Detail>(await save(t.mentor.client, t.applicationId, { revision, ...draft }));
      revision = saved.revision!;
      const before = await stored(t.applicationId);
      expect(
        await code(
          await submit(t.mentor.client, t.applicationId, { revision, criteriaVersion: saved.criteriaVersion }),
        ),
      ).toEqual([409, 'evaluation.incomplete']);
      expect(await stored(t.applicationId)).toEqual(before);
    }
  });

  it('409 conflict.concurrent_update for a stale revision; nothing changes', async () => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4 });
    expect(
      (
        await save(t.hr.client, t.applicationId, {
          revision: seen.revision,
          comment: 'HR text',
          hiringRecommendation: 'No',
          scores: { [c1!.id]: 2 },
        })
      ).status,
    ).toBe(200);
    const before = await stored(t.applicationId);
    expect(await code(await submit(t.mentor.client, t.applicationId, seen))).toEqual([
      409,
      'conflict.concurrent_update',
    ]);
    expect(await stored(t.applicationId)).toEqual(before);
  });

  it.each([
    ['a new active criterion', async (_cs: Criterion[]) => void (await newCriterion())],
    ['an Arabic rename', async (cs: Criterion[]) => setActive(cs[0]!, true, { nameAr: `${cs[0]!.nameAr} (جديد)` })],
    ['an English rename', async (cs: Criterion[]) => setActive(cs[0]!, true, { nameEn: `${cs[0]!.nameEn} (new)` })],
    ['a deactivation', async (cs: Criterion[]) => setActive(cs[1]!, false)],
    ['a reactivation', async (cs: Criterion[]) => setActive(cs[2]!, true)],
  ])(
    '409 evaluation.criteria_changed after %s since the evaluator looked; scores kept; a review then submits',
    async (_change, change) => {
      const cs = await freshCriteria(3);
      await setActive(cs[2]!, false); // inactive at first, for the reactivation case
      const t = await endedTraining();
      const seen = await completeDraft(t.mentor.client, t.applicationId, { [cs[0]!.id]: 4, [cs[1]!.id]: 5 });
      await change(cs);
      const before = await stored(t.applicationId);
      expect(await code(await submit(t.mentor.client, t.applicationId, seen))).toEqual([
        409,
        'evaluation.criteria_changed',
      ]);
      expect(await stored(t.applicationId)).toEqual(before);

      // The review: the updated criteria, the saved scores of those still active; any missing score is added, then submitted.
      const reviewed = await read(t.mentor.client, t.applicationId);
      expect(reviewed.criteriaVersion).not.toBe(seen.criteriaVersion);
      const scores = Object.fromEntries(reviewed.criteria.map((c) => [c.id, c.id === cs[1]!.id ? 5 : 4]));
      const again = await completeDraft(t.mentor.client, t.applicationId, scores);
      expect((await submit(t.mentor.client, t.applicationId, again)).status).toBe(200);
      await freshCriteria(0);
    },
  );

  it.each([
    ['no revision', { criteriaVersion: `c1.${'A'.repeat(43)}` }],
    ['no criteria version', { revision: 1 }],
    ['a negative revision', { revision: -1, criteriaVersion: `c1.${'A'.repeat(43)}` }],
    ['a malformed criteria version', { revision: 1, criteriaVersion: 'c1.short' }],
    ['a revision of the wrong type', { revision: 'one', criteriaVersion: `c1.${'A'.repeat(43)}` }],
    ['scores', { revision: 1, criteriaVersion: `c1.${'A'.repeat(43)}`, scores: {} }],
    ['a comment', { revision: 1, criteriaVersion: `c1.${'A'.repeat(43)}`, comment: 'x' }],
    ['a grade', { revision: 1, criteriaVersion: `c1.${'A'.repeat(43)}`, grade: 'Excellent' }],
    ['a submitter', { revision: 1, criteriaVersion: `c1.${'A'.repeat(43)}`, submittedById: crypto.randomUUID() }],
  ])('400 for a request with %s; nothing changes', async (_case, request) => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4 });
    const before = await stored(t.applicationId);
    expect((await submit(t.mentor.client, t.applicationId, request)).status).toBe(400);
    expect(await stored(t.applicationId)).toEqual(before);
  });
});

describe('final evaluation submission (S2.3): concurrency, on real PostgreSQL', () => {
  it('two simultaneous submissions: exactly one wins, the other gets 409 evaluation.already_submitted, one snapshot', async () => {
    const [c1, c2] = await freshCriteria(2);
    const t = await endedTraining();
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4, [c2!.id]: 4 });
    const results = await holding([lockEvaluation(t.applicationId)], async (end) => {
      const both = Promise.all([
        submit(t.mentor.client, t.applicationId, seen),
        submit(t.hr.client, t.applicationId, seen),
      ]);
      await lockWaits(2);
      await end('COMMIT');
      return Promise.all((await both).map(code));
    });
    expect(results.map((r) => r[0]).sort()).toEqual([200, 409]);
    expect(results.find((r) => r[0] === 409)![1]).toBe('evaluation.already_submitted');
    const row = (await stored(t.applicationId))!;
    expect([row.status, row.version, row.frozen!.length]).toEqual(['Submitted', seen.revision + 1, 2]);
    expect([t.mentor.user.id, t.hr.user.id]).toContain(row.submitted_by_id);
  });

  it('a draft save queued behind a submission gets 409 evaluation.already_submitted', async () => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4 });
    const [submitted, saved] = await holding([lockEvaluation(t.applicationId)], async (end) => {
      const s = submit(t.mentor.client, t.applicationId, seen);
      await lockWaits(1);
      const p = save(t.hr.client, t.applicationId, {
        revision: seen.revision,
        comment: 'Too late',
        hiringRecommendation: 'No',
        scores: { [c1!.id]: 1 },
      });
      await lockWaits(2);
      await end('COMMIT');
      return [await code(await s), await code(await p)];
    });
    expect(submitted[0]).toBe(200);
    expect(saved).toEqual([409, 'evaluation.already_submitted']);
    expect((await stored(t.applicationId))!.frozen).toEqual([
      { criterion: c1!.id, score: 4, nameEn: c1!.nameEn, order: c1!.sortOrder },
    ]);
  });

  it('a submission queued behind a draft save gets 409 conflict.concurrent_update; the save is kept', async () => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    const seen = await completeDraft(t.mentor.client, t.applicationId, { [c1!.id]: 4 });
    const [saved, submitted] = await holding([lockEvaluation(t.applicationId)], async (end) => {
      const p = save(t.hr.client, t.applicationId, {
        revision: seen.revision,
        comment: 'HR first',
        hiringRecommendation: 'No',
        scores: { [c1!.id]: 1 },
      });
      await lockWaits(1);
      const s = submit(t.mentor.client, t.applicationId, seen);
      await lockWaits(2);
      await end('COMMIT');
      return [await code(await p), await code(await s)];
    });
    expect(saved[0]).toBe(200);
    expect(submitted).toEqual([409, 'conflict.concurrent_update']);
    expect(await stored(t.applicationId)).toMatchObject({ status: 'Draft', version: seen.revision + 1, frozen: null });
  });

  it.each([
    [
      'inserted',
      (_cs: Criterion[]) =>
        [
          "INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active, name) VALUES (gen_random_uuid(), 'جديد', 'New', true, 'جديد')",
          [],
        ] as [string, unknown[]],
    ],
    [
      'reactivated',
      (cs: Criterion[]) =>
        ['UPDATE evaluation_criteria SET is_active = true WHERE id = $1', [cs[2]!.id]] as [string, unknown[]],
    ],
    [
      'renamed',
      (cs: Criterion[]) =>
        ["UPDATE evaluation_criteria SET name_en = name_en || ' (new)' WHERE id = $1", [cs[0]!.id]] as [
          string,
          unknown[],
        ],
    ],
    [
      'deactivated',
      (cs: Criterion[]) =>
        ['UPDATE evaluation_criteria SET is_active = false WHERE id = $1', [cs[1]!.id]] as [string, unknown[]],
    ],
  ])(
    'a criterion %s by a transaction in progress: the submission waits for it, then refuses (409), or proceeds if it rolls back',
    async (_change, write) => {
      for (const how of ['COMMIT', 'ROLLBACK'] as const) {
        const cs = await freshCriteria(3);
        await setActive(cs[2]!, false);
        const t = await endedTraining();
        const seen = await completeDraft(t.mentor.client, t.applicationId, { [cs[0]!.id]: 4, [cs[1]!.id]: 4 });
        const result = await holding([write(cs)], async (end) => {
          const s = submit(t.mentor.client, t.applicationId, seen);
          await lockWaits(1); // the submission waits for the criteria table
          await end(how);
          return code(await s);
        });
        if (how === 'COMMIT') {
          expect(result).toEqual([409, 'evaluation.criteria_changed']);
          expect((await stored(t.applicationId))!.status).toBe('Draft');
        } else {
          expect(result[0]).toBe(200);
          expect((await stored(t.applicationId))!.frozen!.map((f) => f.criterion)).toEqual([cs[0]!.id, cs[1]!.id]);
        }
      }
      await freshCriteria(0);
    },
  );

  it.each([
    [
      'create',
      (_cs: Criterion[]) => admin.client.post('/api/admin/evaluation-criteria', { nameAr: 'لاحق', nameEn: 'Later' }),
      201,
    ],
    [
      'reactivate',
      (cs: Criterion[]) =>
        admin.client.put(`/api/admin/evaluation-criteria/${cs[2]!.id}`, {
          nameAr: cs[2]!.nameAr,
          nameEn: cs[2]!.nameEn,
          isActive: true,
        }),
      200,
    ],
    [
      'rename',
      (cs: Criterion[]) =>
        admin.client.put(`/api/admin/evaluation-criteria/${cs[0]!.id}`, {
          nameAr: cs[0]!.nameAr,
          nameEn: 'Renamed later',
          isActive: true,
        }),
      200,
    ],
    [
      'deactivate',
      (cs: Criterion[]) =>
        admin.client.put(`/api/admin/evaluation-criteria/${cs[1]!.id}`, {
          nameAr: cs[1]!.nameAr,
          nameEn: cs[1]!.nameEn,
          isActive: false,
        }),
      200,
    ],
  ])(
    'an Admin %s while a submission holds the criteria lock waits for it; the submission freezes the set it read',
    async (_change, adminWrite, expected) => {
      const cs = await freshCriteria(3);
      await setActive(cs[2]!, false);
      const t = await endedTraining();
      const seen = await completeDraft(t.mentor.client, t.applicationId, { [cs[0]!.id]: 5, [cs[1]!.id]: 4 });
      const [submitted, written] = await holding([lockScores(t.applicationId)], async (end) => {
        const s = submit(t.mentor.client, t.applicationId, seen);
        await submissionPausedHoldingCriteriaLock(SNAPSHOT_UPDATE);
        const w = adminWrite(cs);
        await lockWaits(2); // the Admin write waits for the criteria table
        await end('COMMIT');
        return [await code(await s), (await w).status];
      });
      expect(submitted[0]).toBe(200);
      expect(written).toBe(expected);
      const d = await read(t.mentor.client, t.applicationId);
      expect(d.criteria).toEqual(
        [cs[0], cs[1]].map((c) => ({ id: c!.id, nameAr: c!.nameAr, nameEn: c!.nameEn, sortOrder: c!.sortOrder })),
      );
      expect(d.submission).toMatchObject({ scores: { [cs[0]!.id]: 5, [cs[1]!.id]: 4 }, grade: 'Excellent' });
      await freshCriteria(0);
    },
  );

  it('no active criterion: a criterion created during the submission is refused (409) or waits, as ordered', async () => {
    // Before the submission's lock: it waits for the insert, then refuses the changed (no longer empty) set.
    await freshCriteria(0);
    const a = await endedTraining();
    const seenA = await completeDraft(a.mentor.client, a.applicationId, {});
    const refused = await holding(
      [
        [
          "INSERT INTO evaluation_criteria (id, name_ar, name_en, is_active, name) VALUES (gen_random_uuid(), 'جديد', 'New', true, 'جديد')",
          [],
        ],
      ],
      async (end) => {
        const s = submit(a.mentor.client, a.applicationId, seenA);
        await lockWaits(1);
        await end('COMMIT');
        return code(await s);
      },
    );
    expect(refused).toEqual([409, 'evaluation.criteria_changed']);

    // After it: the Admin's creation waits; the evaluation is submitted comment-only and never gains the criterion.
    await freshCriteria(0);
    const b = await endedTraining();
    const seenB = await completeDraft(b.mentor.client, b.applicationId, {});
    const [submitted, created] = await holding([lockEvaluationWrites], async (end) => {
      const s = submit(b.mentor.client, b.applicationId, seenB);
      await submissionPausedHoldingCriteriaLock(SUBMISSION_UPDATE);
      const w = admin.client.post('/api/admin/evaluation-criteria', { nameAr: 'لاحق', nameEn: 'Later' });
      await lockWaits(2);
      await end('COMMIT');
      return [await code(await s), (await w).status];
    });
    expect([submitted[0], created]).toEqual([200, 201]);
    const d = await read(b.mentor.client, b.applicationId);
    expect(d).toMatchObject({ commentOnly: true, criteria: [] });
    expect(d.submission!.grade).toBeNull();
    await freshCriteria(0);
  });

  it('leaves no lock or open transaction behind', async () => {
    const left = await db((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND (wait_event_type = 'Lock' OR state LIKE 'idle in transaction%')`,
      ),
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe('submitEvaluation and the database guards', () => {
  const training = { application_id: '01a1aaaa-0000-7000-8000-000000000001' } as EvaluableTraining;
  const input = { revision: 1, criteriaVersion: '' };
  /** A transaction where `fail` throws for the statement containing `at`; the rest answers as a complete draft would. */
  const queryable = (at: string, fail: object | null, frozenCount?: number): Queryable =>
    ({
      async query(sql: string) {
        if (sql.includes(at) && fail) throw Object.assign(new Error('database message'), fail);
        if (sql.includes('FOR UPDATE'))
          return {
            rows: [{ id: 'e', status: 'Draft', version: 1, comment: 'c', hiring_recommendation: 'Yes' }],
            rowCount: 1,
          };
        if (sql.includes('FROM evaluation_criteria'))
          return { rows: [{ id: 'k', name_ar: 'a', name_en: 'b', sort_order: 1 }], rowCount: 1 };
        if (sql.includes('score IS NOT NULL') && sql.startsWith('SELECT'))
          return { rows: [{ criterion_id: 'k', score: 3 }], rowCount: 1 };
        if (sql.includes('UPDATE evaluation_scores')) return { rows: [], rowCount: frozenCount ?? 1 };
        return { rows: [], rowCount: 1 };
      },
    }) as unknown as Queryable;
  const run = async (q: Queryable) => {
    const { criteriaVersion } = await import('../src/domain/evaluation');
    const version = await criteriaVersion([{ id: 'k', nameAr: 'a', nameEn: 'b', sortOrder: 1 }]);
    return submitEvaluation(q, training, 'u', { ...input, criteriaVersion: version }, new Date()).then(
      () => 'submitted',
      (e) => e,
    );
  };

  it.each(['evaluation_scores_submitted_readonly', 'evaluations_submitted_readonly'])(
    'reports %s as 409 evaluation.already_submitted',
    async (constraint) => {
      const error = await run(queryable('UPDATE evaluations', { code: '23001', constraint }));
      expect(error).toBeInstanceOf(StateConflictError);
      expect((error as StateConflictError).code).toBe('evaluation.already_submitted');
    },
  );

  it.each([
    ['another guard', { code: '23001', constraint: 'evaluations_submission_immutable' }],
    ['a check constraint', { code: '23514', constraint: 'ck_evaluations_submitted_content' }],
    ['a lost connection', { code: '08006' }],
  ])('lets %s through unchanged (an error, never a success)', async (_label, shape) => {
    const error = await run(queryable('UPDATE evaluations', shape));
    expect(error).not.toBeInstanceOf(StateConflictError);
    expect(error).not.toBeInstanceOf(ConcurrencyError);
    expect(error).toMatchObject(shape);
  });

  it('refuses a snapshot that does not cover exactly the active criteria (rolled back by the caller)', async () => {
    const error = await run(queryable('never', null, 0));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StateConflictError);
    expect(String(error)).toMatch(/froze 0 scores instead of 1/);
  });
});
