import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConcurrencyError, DomainError, StateConflictError } from '../src/domain/errors';
import { correctionDiff, correctionInput } from '../src/domain/evaluation';
import { calendarDate } from '../src/domain/training';
import { correctionRefusal } from '../src/features/evaluation/correct';
import { body, setRole, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-database';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Correcting a submitted final evaluation, stage S2.4 (R27; owner decisions of 2026-11-23, AD-72):
 * `GET /api/evaluations/:id/correction`, `POST /api/evaluations/:id/corrections` and `submission.latestCorrection`.
 * A correction starts from a submitted evaluation, and a submission needs a score for every active criterion, so this
 * file runs on a database of its own in the disposable container (alternative B, test/isolated-database.ts). Its tests
 * run in order. The concurrency tests use independent PostgreSQL connections and wait for an observed lock wait.
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
interface LatestCorrection {
  correctedAt: string;
  correctedBy: { name: string };
  reason: string | null;
}
interface Submission {
  submittedAt: string;
  submittedBy: { name: string };
  comment: string;
  hiringRecommendation: string;
  scores: Record<string, number>;
  grade: string | null;
  latestCorrection: LatestCorrection | null;
}
interface Detail {
  status: string;
  commentOnly: boolean;
  criteria: Criterion[];
  revision?: number;
  criteriaVersion?: string;
  submission?: Submission;
}
interface CorrectionStart {
  commentOnly: boolean;
  criteria: Criterion[];
  revision: number;
  comment: string;
  hiringRecommendation: string;
  scores: Record<string, number>;
}

/** Only `count` active criteria, this test's own. */
async function freshCriteria(count: number): Promise<Criterion[]> {
  const active = await db((c) =>
    c.query<Criterion>(
      'SELECT id, name_ar AS "nameAr", name_en AS "nameEn", sort_order AS "sortOrder" FROM evaluation_criteria WHERE is_active',
    ),
  );
  for (const c of active.rows) {
    const response = await admin.client.put(`/api/admin/evaluation-criteria/${c.id}`, {
      nameAr: c.nameAr,
      nameEn: c.nameEn,
      isActive: false,
    });
    expect(response.status).toBe(200);
  }
  const created: Criterion[] = [];
  for (let i = 0; i < count; i++) {
    const nameEn = `Criterion ${crypto.randomUUID().slice(0, 8)}`;
    const response = await admin.client.post('/api/admin/evaluation-criteria', { nameAr: `معيار ${nameEn}`, nameEn });
    expect(response.status).toBe(201);
    created.push(await body<Criterion>(response));
  }
  return created;
}

/** An ended training (EndedEarly today): responsible HR = the accepting HR, final mentor = an Employee. */
async function endedTraining(through: TestApi = api) {
  const hr = await signInStaff(through, 'HR');
  const mentor = await signInStaff(through, 'Employee');
  const trainee = await signInTrainee(through);
  const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Correct Trainee');
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
const start = async (client: TestClient, applicationId: string) => {
  const response = await client.get(`/api/evaluations/${applicationId}/correction`);
  expect(response.status).toBe(200);
  return body<CorrectionStart>(response);
};
const correct = (client: TestClient, applicationId: string, request: Record<string, unknown>) =>
  client.post(`/api/evaluations/${applicationId}/corrections`, request);
const code = async (response: Response) => [response.status, (await body<{ code?: string }>(response)).code];

/** A submitted evaluation: `scores` by criterion, comment "Submitted comment", recommendation Yes, by the mentor. */
async function submitted(count: number, scores: number[] = [], through: TestApi = api) {
  const criteria = await freshCriteria(count);
  const t = await endedTraining(through);
  const values = Object.fromEntries(criteria.map((c, i) => [c.id, scores[i] ?? 3]));
  const saved = await t.mentor.client.put(`/api/evaluations/${t.applicationId}/draft`, {
    revision: 0,
    comment: 'Submitted comment',
    hiringRecommendation: 'Yes',
    scores: values,
  });
  expect(saved.status).toBe(200);
  const draft = await body<Detail>(saved);
  const done = await t.mentor.client.post(`/api/evaluations/${t.applicationId}/submit`, {
    revision: draft.revision,
    criteriaVersion: draft.criteriaVersion,
  });
  expect(done.status).toBe(200);
  return { ...t, criteria, values, detail: await body<Detail>(done) };
}

/** The request that keeps everything as it is (a test then changes what it needs). */
const unchanged = (s: CorrectionStart) => ({
  revision: s.revision,
  comment: s.comment,
  hiringRecommendation: s.hiringRecommendation,
  scores: { ...s.scores },
  reason: null as string | null,
});

/** The stored evaluation, to prove what changed (or that nothing did). */
const stored = (applicationId: string) =>
  db((c) =>
    c.query<{
      status: string;
      version: number;
      comment: string;
      hiring_recommendation: string;
      submitted_by_id: string;
      submitted_at: Date;
      frozen: { criterion: string; score: number; nameAr: string; nameEn: string; order: number }[] | null;
      corrections: number;
    }>(
      `SELECT e.status, e.version, e.comment, e.hiring_recommendation, e.submitted_by_id, e.submitted_at,
              (SELECT json_agg(json_build_object('criterion', s.criterion_id, 'score', s.score, 'nameAr', s.frozen_name_ar,
                                                 'nameEn', s.frozen_name_en, 'order', s.frozen_sort_order)
                               ORDER BY s.frozen_sort_order)
                 FROM evaluation_scores s WHERE s.evaluation_id = e.id AND s.frozen_sort_order IS NOT NULL) AS frozen,
              (SELECT count(*)::int FROM evaluation_corrections c WHERE c.evaluation_id = e.id) AS corrections
         FROM evaluations e WHERE e.application_id = $1`,
      [applicationId],
    ),
  ).then((r) => r.rows[0]!);

const staffName = (id: string) =>
  db((c) => c.query<{ full_name: string }>('SELECT full_name FROM employees WHERE id = $1', [id])).then(
    (r) => r.rows[0]!.full_name,
  );

// ── Lock observation (this database is this file's alone, and its tests run in order) ─────────────────────────────

/** An owner transaction holding the evaluation row lock until `end`; always closed in `finally`. */
async function holdingEvaluation<T>(
  applicationId: string,
  work: (end: (how: 'COMMIT' | 'ROLLBACK') => Promise<void>) => Promise<T>,
) {
  const client = new pg.Client({ connectionString: isolated.ownerUrl });
  client.on('error', () => undefined);
  await client.connect();
  let open = true;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM evaluations WHERE application_id = $1 FOR UPDATE', [applicationId]);
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

/** An owner transaction holding the locks of `statements` until `end`; always closed in `finally`. */
async function holding<T>(
  statements: [string, unknown[]][],
  work: (end: (how: 'COMMIT' | 'ROLLBACK') => Promise<void>) => Promise<T>,
) {
  const client = new pg.Client({ connectionString: isolated.ownerUrl });
  client.on('error', () => undefined);
  await client.connect();
  let open = true;
  try {
    await client.query('BEGIN');
    for (const [text, params] of statements) await client.query(text, params);
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

/** Resolves once `count` sessions of this database wait for a lock in a statement containing `sql`; fails after 20 s. */
async function waitingIn(sql: string, count = 1) {
  for (let i = 0; i < 1000; i++) {
    const n = await db((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND strpos(query, $1) > 0`,
        [sql],
      ),
    ).then((r) => r.rows[0]!.n);
    if (n >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Expected ${count} session(s) waiting for a lock in: ${sql}`);
}

/** The statements each side waits in (the exact SQL of the code under test). */
const WAITS = {
  scoreUpdate: 'UPDATE evaluation_scores s SET score = c.score',
  applicationShare: 'SELECT id FROM training_applications WHERE id = $1 FOR SHARE',
  evaluationUpdate: 'WHERE application_id = $1 FOR UPDATE',
  roleChangeTarget: 'FROM employees WHERE id = $1 FOR NO KEY UPDATE',
  replacementApplication: 'SELECT status FROM training_applications WHERE id = $1 FOR NO KEY UPDATE',
  replacementCandidate: 'SELECT role FROM employees WHERE id = $1 FOR SHARE',
};

/** Pauses a correction that changes a score after its locks, its rights check and its record, until `end`. */
const scoreRowsOf = (applicationId: string): [string, unknown[]] => [
  `SELECT s.id FROM evaluation_scores s JOIN evaluations e ON e.id = s.evaluation_id
    WHERE e.application_id = $1 FOR UPDATE OF s`,
  [applicationId],
];

/**
 * Everything a correction could leave behind for this evaluation: its values, counter, records and every audit row of
 * the evaluation, its scores and its correction records. A refused correction leaves it exactly as it was.
 */
const trace = (applicationId: string) =>
  db((c) =>
    c.query(
      `SELECT e.version, e.comment, e.hiring_recommendation, e.submitted_by_id, e.submitted_at,
              (SELECT json_agg(json_build_object('c', s.criterion_id, 's', s.score) ORDER BY s.criterion_id)
                 FROM evaluation_scores s WHERE s.evaluation_id = e.id) AS scores,
              (SELECT count(*)::int FROM evaluation_corrections c WHERE c.evaluation_id = e.id) AS records,
              (SELECT count(*)::int FROM audit_logs a
                WHERE (a.table_name = 'evaluations' AND a.entity_id = e.id::text)
                   OR (a.table_name = 'evaluation_scores'
                       AND a.entity_id IN (SELECT s.id::text FROM evaluation_scores s WHERE s.evaluation_id = e.id))
                   OR (a.table_name = 'evaluation_corrections' AND a.new_values ->> 'evaluation_id' = e.id::text)) AS audits
         FROM evaluations e WHERE e.application_id = $1`,
      [applicationId],
    ),
  ).then((r) => r.rows[0] as Record<string, unknown>);

const changeRole = (employeeId: string, role: string) =>
  admin.client.put(`/api/admin/users/${employeeId}/role`, { role });
const replaceResponsibleHr = (applicationId: string, hrId: string) =>
  admin.client.put(`/api/admin/accepted-trainees/${applicationId}/responsible-hr`, { hrId });
/** The audit number of a write, to prove which of two transactions committed first. */
const auditId = (table: string, entityId: string, operation: string) =>
  db((c) =>
    c.query<{ id: string }>(
      'SELECT max(id)::text AS id FROM audit_logs WHERE table_name = $1 AND entity_id = $2 AND operation = $3',
      [table, entityId, operation],
    ),
  ).then((r) => BigInt(r.rows[0]!.id));
const correctionAuditId = (applicationId: string) =>
  db((c) =>
    c.query<{ id: string }>(
      `SELECT max(a.id)::text AS id FROM audit_logs a JOIN evaluation_corrections c
          ON a.table_name = 'evaluation_corrections' AND a.entity_id = c.id::text AND a.operation = 'INSERT'
        JOIN evaluations e ON e.id = c.evaluation_id WHERE e.application_id = $1`,
      [applicationId],
    ),
  ).then((r) => BigInt(r.rows[0]!.id));

// ── Successful corrections ────────────────────────────────────────────────────────────────────────────────────────

describe('final evaluation correction (S2.4): successful corrections through HTTP', () => {
  it('the correction page starts from the frozen criteria and the current values, with the revision; no other id', async () => {
    const s = await submitted(2, [4, 2]);
    const begin = await start(s.mentor.client, s.applicationId);
    expect(begin).toMatchObject({
      commentOnly: false,
      revision: s.detail.revision ?? begin.revision,
      comment: 'Submitted comment',
      hiringRecommendation: 'Yes',
      scores: { [s.criteria[0]!.id]: 4, [s.criteria[1]!.id]: 2 },
    });
    expect(begin.criteria.map((c) => [c.id, c.nameEn, c.sortOrder])).toEqual(
      s.criteria.map((c) => [c.id, c.nameEn, c.sortOrder]),
    );
    expect(begin.revision).toBe((await stored(s.applicationId)).version);
    const text = JSON.stringify(begin);
    const ids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(new Set(ids)).toEqual(new Set([s.applicationId, ...s.criteria.map((c) => c.id)]));
  });

  it('the final mentor corrects one score: recalculated grade, latest correction, submitter and frozen names unchanged', async () => {
    const s = await submitted(2, [4, 4]); // VeryGood
    const before = await stored(s.applicationId);
    const begin = await start(s.mentor.client, s.applicationId);
    const response = await correct(s.mentor.client, s.applicationId, {
      ...unchanged(begin),
      scores: { ...begin.scores, [s.criteria[1]!.id]: 5 },
      reason: '  Wrong score typed  ',
    });
    expect(response.status).toBe(200);
    const d = await body<Detail>(response);
    expect(d.status).toBe('Submitted');
    expect(d.submission).toMatchObject({
      scores: { [s.criteria[0]!.id]: 4, [s.criteria[1]!.id]: 5 },
      grade: 'Excellent',
      comment: 'Submitted comment',
      hiringRecommendation: 'Yes',
      submittedBy: { name: await staffName(s.mentor.user.id) },
      submittedAt: s.detail.submission!.submittedAt,
    });
    const latest = d.submission!.latestCorrection!;
    expect(Object.keys(latest).sort()).toEqual(['correctedAt', 'correctedBy', 'reason']);
    expect(latest.correctedBy).toEqual({ name: await staffName(s.mentor.user.id) });
    expect(latest.reason).toBe('Wrong score typed');
    expect(JSON.stringify(d.submission)).not.toMatch(/"id"|auditId|history|previous/i);

    const after = await stored(s.applicationId);
    expect(after.version).toBe(before.version + 1);
    expect([after.submitted_by_id, after.submitted_at.toISOString()]).toEqual([
      before.submitted_by_id,
      before.submitted_at.toISOString(),
    ]);
    expect(after.frozen!.map(({ score: _s, ...rest }) => rest)).toEqual(
      before.frozen!.map(({ score: _s, ...rest }) => rest),
    );
    expect(after.corrections).toBe(1);
    // The detail read afterwards is the same.
    expect((await read(s.hr.client, s.applicationId)).submission).toEqual(d.submission);
  });

  it('the responsible HR corrects several values at once; a blank reason is none; one record, one counter step', async () => {
    const s = await submitted(3, [3, 3, 3]); // Good
    const begin = await start(s.hr.client, s.applicationId);
    const response = await correct(s.hr.client, s.applicationId, {
      ...unchanged(begin),
      comment: '  A corrected comment  ',
      hiringRecommendation: 'Maybe',
      scores: { [s.criteria[0]!.id]: 1, [s.criteria[1]!.id]: 2, [s.criteria[2]!.id]: 3 },
      reason: '   ',
    });
    expect(response.status).toBe(200);
    const d = await body<Detail>(response);
    expect(d.submission).toMatchObject({
      comment: 'A corrected comment',
      hiringRecommendation: 'Maybe',
      grade: 'Pass',
      latestCorrection: { correctedBy: { name: await staffName(s.hr.user.id) }, reason: null },
    });
    const after = await stored(s.applicationId);
    expect([after.version, after.corrections]).toEqual([begin.revision + 1, 1]);
  });

  it('a comment-only evaluation stays comment-only: scores {} and no grade', async () => {
    const s = await submitted(0);
    const begin = await start(s.mentor.client, s.applicationId);
    expect([begin.commentOnly, begin.criteria, begin.scores]).toEqual([true, [], {}]);
    const response = await correct(s.mentor.client, s.applicationId, {
      ...unchanged(begin),
      hiringRecommendation: 'No',
    });
    expect(response.status).toBe(200);
    const d = await body<Detail>(response);
    expect([d.commentOnly, d.submission!.grade, d.submission!.scores, d.submission!.hiringRecommendation]).toEqual([
      true,
      null,
      {},
      'No',
    ]);
  });

  it('a reason of 2,000 characters is kept; the correction is audited as the corrector in one transaction', async () => {
    const s = await submitted(1, [2]);
    const begin = await start(s.mentor.client, s.applicationId);
    const reason = 'ع'.repeat(2000);
    const response = await correct(s.mentor.client, s.applicationId, {
      ...unchanged(begin),
      comment: 'Changed',
      scores: { [s.criteria[0]!.id]: 3 },
      reason,
    });
    expect(response.status).toBe(200);
    expect((await body<Detail>(response)).submission!.latestCorrection!.reason).toBe(reason);
    const audit = await db((c) =>
      c.query<{ table_name: string; operation: string; actor_type: string; actor_id: string; tx: string }>(
        `SELECT a.table_name, a.operation, a.actor_type, a.actor_id, a.transaction_id::text AS tx FROM audit_logs a
          WHERE a.transaction_id = (SELECT x.transaction_id FROM audit_logs x JOIN evaluation_corrections c
                                       ON x.table_name = 'evaluation_corrections' AND x.entity_id = c.id::text
                                     JOIN evaluations e ON e.id = c.evaluation_id WHERE e.application_id = $1)
          ORDER BY a.id`,
        [s.applicationId],
      ),
    );
    // The real audit: the record, the changed score, and one evaluations UPDATE (comment, counter and time in one statement).
    expect(audit.rows.map((r) => `${r.table_name}:${r.operation}`)).toEqual([
      'evaluation_corrections:INSERT',
      'evaluation_scores:UPDATE',
      'evaluations:UPDATE',
    ]);
    expect(new Set(audit.rows.map((r) => `${r.actor_type}:${r.actor_id}`))).toEqual(
      new Set([`Staff:${s.mentor.user.id}`]),
    );
    const change = await db((c) =>
      c.query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
        `SELECT a.old_values, a.new_values FROM audit_logs a JOIN evaluations e ON a.entity_id = e.id::text
          WHERE a.table_name = 'evaluations' AND a.operation = 'UPDATE' AND e.application_id = $1 ORDER BY a.id DESC LIMIT 1`,
        [s.applicationId],
      ),
    );
    expect(change.rows[0]).toMatchObject({
      old_values: { comment: 'Submitted comment' },
      new_values: { comment: 'Changed' },
    });
    const record = await db((c) =>
      c.query<{ id: string; corrected_by_id: string }>(
        `SELECT c.id, c.corrected_by_id FROM evaluation_corrections c JOIN evaluations e ON e.id = c.evaluation_id
          WHERE e.application_id = $1`,
        [s.applicationId],
      ),
    );
    expect(record.rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUID v7
    expect(record.rows[0]!.corrected_by_id).toBe(s.mentor.user.id);
  });
});

describe('final evaluation correction (S2.4): the latest correction', () => {
  it('two corrections with the same time: the latest is the one audited last', async () => {
    let fixed: Date | null = null; // frozen only for the corrections (sign-in checks the token times)
    const sameTime = isolated.api({ now: () => fixed ?? new Date() });
    const s = await submitted(1, [3], sameTime);
    fixed = new Date(Date.now() - 60_000);
    let begin = await start(s.mentor.client, s.applicationId);
    expect(
      (await correct(s.mentor.client, s.applicationId, { ...unchanged(begin), comment: 'First', reason: 'one' }))
        .status,
    ).toBe(200);
    begin = await start(s.hr.client, s.applicationId);
    const second = await correct(s.hr.client, s.applicationId, {
      ...unchanged(begin),
      comment: 'Second',
      reason: 'two',
    });
    expect(second.status).toBe(200);
    const latest = (await body<Detail>(second)).submission!.latestCorrection!;
    expect(latest).toEqual({
      correctedAt: fixed.toISOString(),
      correctedBy: { name: await staffName(s.hr.user.id) },
      reason: 'two',
    });
    expect((await read(s.mentor.client, s.applicationId)).submission!.latestCorrection).toEqual(latest);
  });

  it('ordered by the audit, never by the id: a UUID v4 record (earlier code) before or after a v7 one', async () => {
    const s = await submitted(1, [3]);
    /** A correction made directly by the owner, in a valid correction transaction, with a UUID v4 id. */
    const v4Correction = (comment: string, reason: string) =>
      db(async (c) => {
        const id = `ffffffff-ffff-4fff-bfff-${crypto.randomUUID().slice(-12)}`; // sorts after any v7 id
        await c.query('BEGIN');
        await c.query("SELECT set_config('ims.actor_type', 'Staff', true), set_config('ims.actor_id', $1, true)", [
          s.hr.user.id,
        ]);
        const { rows } = await c.query<{ id: string }>('SELECT id FROM evaluations WHERE application_id = $1', [
          s.applicationId,
        ]);
        await c.query(
          'INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at, reason) VALUES ($1, $2, $3, now(), $4)',
          [id, rows[0]!.id, s.hr.user.id, reason],
        );
        await c.query('UPDATE evaluations SET comment = $2, version = version + 1 WHERE id = $1', [
          rows[0]!.id,
          comment,
        ]);
        await c.query('COMMIT');
      });

    await v4Correction('By v4', 'v4 first');
    let begin = await start(s.mentor.client, s.applicationId);
    let response = await correct(s.mentor.client, s.applicationId, {
      ...unchanged(begin),
      comment: 'By v7',
      reason: 'v7',
    });
    expect((await body<Detail>(response)).submission!.latestCorrection!.reason).toBe('v7');

    await v4Correction('By v4 again', 'v4 last');
    expect((await read(s.mentor.client, s.applicationId)).submission!.latestCorrection!.reason).toBe('v4 last');
    begin = await start(s.mentor.client, s.applicationId);
    expect(begin.comment).toBe('By v4 again');
    response = await correct(s.mentor.client, s.applicationId, { ...unchanged(begin), comment: 'Final', reason: null });
    expect((await body<Detail>(response)).submission!.latestCorrection).toMatchObject({ reason: null });
  });

  it('a submitted evaluation never corrected has latestCorrection null', async () => {
    const s = await submitted(1);
    expect(s.detail.submission!.latestCorrection).toBeNull();
  });
});

// ── Who may correct, and the refusals ─────────────────────────────────────────────────────────────────────────────

describe('final evaluation correction (S2.4): who may correct, and the refusals', () => {
  it('401 signed out, 403 Admin and trainee, 404 for unrelated staff like a missing training; nothing changes', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.mentor.client, s.applicationId);
    const request = { ...unchanged(begin), comment: 'Not allowed' };
    const missing = await correct(s.hr.client, crypto.randomUUID(), request);
    expect(missing.status).toBe(404);
    const { traceId: _m, ...notFound } = await body<Record<string, unknown>>(missing);

    expect((await correct(api.client(), s.applicationId, request)).status).toBe(401);
    expect((await api.client().get(`/api/evaluations/${s.applicationId}/correction`)).status).toBe(401);
    for (const client of [admin.client, s.trainee.client]) {
      expect((await correct(client, s.applicationId, request)).status).toBe(403);
      expect((await client.get(`/api/evaluations/${s.applicationId}/correction`)).status).toBe(403);
    }
    for (const client of [(await signInStaff(api, 'HR')).client, (await signInStaff(api, 'Employee')).client]) {
      const response = await correct(client, s.applicationId, request);
      expect(response.status).toBe(404);
      const { traceId: _o, ...rest } = await body<Record<string, unknown>>(response);
      expect(rest).toEqual(notFound);
      expect((await client.get(`/api/evaluations/${s.applicationId}/correction`)).status).toBe(404);
    }
    await setRole(s.mentor.email, 'Admin', isolated.ownerUrl); // checked at correction time
    expect((await correct(s.mentor.client, s.applicationId, request)).status).toBe(403);
    await setRole(s.mentor.email, 'Employee', isolated.ownerUrl);
    expect((await stored(s.applicationId)).corrections).toBe(0);
  });

  it('a former mentor (transferred away) and a replaced or demoted HR cannot correct; the new evaluators can', async () => {
    await freshCriteria(0);
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
    const ended = await hr.client.post(`/api/hr/assignments/${latest.rows[0]!.id}/complete`, {
      endDate: today(),
      reason: 'Synthetic',
    });
    expect(ended.status).toBe(200);
    const saved = await body<Detail>(
      await next.client.put(`/api/evaluations/${applicationId}/draft`, {
        revision: 0,
        comment: 'Submitted comment',
        hiringRecommendation: 'Yes',
        scores: {},
      }),
    );
    expect(
      (
        await next.client.post(`/api/evaluations/${applicationId}/submit`, {
          revision: saved.revision,
          criteriaVersion: saved.criteriaVersion,
        })
      ).status,
    ).toBe(200);
    const begin = await start(next.client, applicationId);
    const request = { ...unchanged(begin), comment: 'Corrected' };

    expect((await correct(previous.client, applicationId, request)).status).toBe(404);
    await setRole(hr.email, 'Employee', isolated.ownerUrl);
    expect((await correct(hr.client, applicationId, request)).status).toBe(404);
    await setRole(hr.email, 'HR', isolated.ownerUrl);
    const replacement = await signInStaff(api, 'HR');
    expect(
      (
        await admin.client.put(`/api/admin/accepted-trainees/${applicationId}/responsible-hr`, {
          hrId: replacement.user.id,
        })
      ).status,
    ).toBe(200);
    expect((await correct(hr.client, applicationId, request)).status).toBe(404);
    expect((await stored(applicationId)).corrections).toBe(0);
    expect((await correct(replacement.client, applicationId, request)).status).toBe(200);
    const again = await start(next.client, applicationId);
    expect((await correct(next.client, applicationId, { ...unchanged(again), comment: 'By mentor' })).status).toBe(200);
  });

  it('409 evaluation.not_submitted for a draft or a training without an evaluation', async () => {
    const [c1] = await freshCriteria(1);
    const t = await endedTraining();
    const request = {
      revision: 0,
      comment: 'x',
      hiringRecommendation: 'Yes',
      scores: { [c1!.id]: 3 },
      reason: null,
    };
    expect(await code(await correct(t.mentor.client, t.applicationId, request))).toEqual([
      409,
      'evaluation.not_submitted',
    ]);
    expect(await code(await t.mentor.client.get(`/api/evaluations/${t.applicationId}/correction`))).toEqual([
      409,
      'evaluation.not_submitted',
    ]);
    const saved = await t.mentor.client.put(`/api/evaluations/${t.applicationId}/draft`, {
      ...request,
      reason: undefined,
    });
    expect(saved.status).toBe(200);
    const revision = (await body<Detail>(saved)).revision;
    expect(await code(await correct(t.hr.client, t.applicationId, { ...request, revision }))).toEqual([
      409,
      'evaluation.not_submitted',
    ]);
    expect(
      await db((c) =>
        c.query(
          'SELECT 1 FROM evaluation_corrections c JOIN evaluations e ON e.id = c.evaluation_id WHERE e.application_id = $1',
          [t.applicationId],
        ),
      ).then((r) => r.rowCount),
    ).toBe(0);
  });

  it('409 evaluation.no_changes: the same values, a reason alone, or only whitespace around the comment', async () => {
    const s = await submitted(2, [4, 3]);
    const begin = await start(s.mentor.client, s.applicationId);
    for (const request of [
      unchanged(begin),
      { ...unchanged(begin), reason: 'Only a reason' },
      { ...unchanged(begin), comment: `  ${begin.comment}  ` },
    ]) {
      expect(await code(await correct(s.mentor.client, s.applicationId, request))).toEqual([
        409,
        'evaluation.no_changes',
      ]);
    }
    expect(await stored(s.applicationId)).toMatchObject({ version: begin.revision, corrections: 0 });
  });

  it('409 conflict.concurrent_update for a stale revision; nothing changes', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.mentor.client, s.applicationId);
    expect((await correct(s.hr.client, s.applicationId, { ...unchanged(begin), comment: 'HR first' })).status).toBe(
      200,
    );
    expect(
      await code(await correct(s.mentor.client, s.applicationId, { ...unchanged(begin), comment: 'Stale' })),
    ).toEqual([409, 'conflict.concurrent_update']);
    expect(await stored(s.applicationId)).toMatchObject({ comment: 'HR first', corrections: 1 });
  });

  it.each([
    ['a missing reason field', (r: Record<string, unknown>) => ({ ...r, reason: undefined })],
    ['a missing scores field', (r: Record<string, unknown>) => ({ ...r, scores: undefined })],
    ['a blank comment', (r: Record<string, unknown>) => ({ ...r, comment: '   ' })],
    ['no comment', (r: Record<string, unknown>) => ({ ...r, comment: null })],
    ['a comment of 4,001 characters', (r: Record<string, unknown>) => ({ ...r, comment: 'ع'.repeat(4001) })],
    ['no recommendation', (r: Record<string, unknown>) => ({ ...r, hiringRecommendation: null })],
    ['an unknown recommendation', (r: Record<string, unknown>) => ({ ...r, hiringRecommendation: 'Perhaps' })],
    [
      'a reason of 2,001 characters',
      (r: Record<string, unknown>) => ({ ...r, comment: 'x', reason: 'ع'.repeat(2001) }),
    ],
    ['a score out of range', (r: Record<string, unknown>) => ({ ...r, scores: scoresWith(r, 6) })],
    ['a fractional score', (r: Record<string, unknown>) => ({ ...r, scores: scoresWith(r, 2.5) })],
    ['a frozen criterion left out', (r: Record<string, unknown>) => ({ ...r, comment: 'x', scores: {} })],
    [
      'an extra criterion',
      (r: Record<string, unknown>) => ({
        ...r,
        comment: 'x',
        scores: { ...(r.scores as object), [crypto.randomUUID()]: 3 },
      }),
    ],
    ['an unknown field', (r: Record<string, unknown>) => ({ ...r, submittedBy: 'someone' })],
  ])('400 for %s; nothing changes', async (_label, change) => {
    const s = await submitted(1, [3]);
    const begin = await start(s.mentor.client, s.applicationId);
    const request = JSON.parse(JSON.stringify(change(unchanged(begin)))) as Record<string, unknown>;
    expect((await correct(s.mentor.client, s.applicationId, request)).status).toBe(400);
    expect(await stored(s.applicationId)).toMatchObject({ version: begin.revision, corrections: 0 });
  });
});

const scoresWith = (r: Record<string, unknown>, score: number) =>
  Object.fromEntries(Object.keys(r.scores as object).map((k) => [k, score]));

// ── Concurrency and authorization changes, on real PostgreSQL ────────────────────────────────────────────────────

describe('final evaluation correction (S2.4): concurrency, on real PostgreSQL', () => {
  it('F. two simultaneous corrections of the same revision: one wins, the other gets 409 and leaves nothing', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.mentor.client, s.applicationId);
    const results = await holdingEvaluation(s.applicationId, async (end) => {
      const both = Promise.all([
        correct(s.mentor.client, s.applicationId, { ...unchanged(begin), comment: 'Mentor' }),
        correct(s.hr.client, s.applicationId, { ...unchanged(begin), comment: 'HR' }),
      ]);
      await waitingIn(WAITS.evaluationUpdate, 2);
      await end('COMMIT');
      return Promise.all((await both).map(code));
    });
    expect(results.map((r) => r[0]).sort()).toEqual([200, 409]);
    expect(results.find((r) => r[0] === 409)![1]).toBe('conflict.concurrent_update');
    // Exactly one correction: one record, one INSERT audit row, one counter step; the loser left nothing.
    expect(await trace(s.applicationId)).toMatchObject({ version: begin.revision + 1, records: 1 });
    const inserts = await db((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_logs a JOIN evaluations e ON a.new_values ->> 'evaluation_id' = e.id::text
          WHERE a.table_name = 'evaluation_corrections' AND a.operation = 'INSERT' AND e.application_id = $1`,
        [s.applicationId],
      ),
    );
    expect(inserts.rows[0]!.n).toBe(1);
  });

  it('A. HR demoted before the correction locks the staff row: 404, nothing written or audited', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.hr.client, s.applicationId);
    const before = await trace(s.applicationId);
    const result = await holdingEvaluation(s.applicationId, async (end) => {
      const pending = correct(s.hr.client, s.applicationId, { ...unchanged(begin), comment: 'Too late' });
      await waitingIn(WAITS.evaluationUpdate); // holds the application (SHARE), waits for the evaluation
      expect((await changeRole(s.hr.user.id, 'Employee')).status).toBe(200); // the staff row is not locked yet
      await end('COMMIT');
      return code(await pending);
    });
    expect(result[0]).toBe(404);
    expect(await trace(s.applicationId)).toEqual(before);
    await setRole(s.hr.email, 'HR', isolated.ownerUrl);
  });

  it('B. HR demoted after the rights check, before COMMIT: the demotion waits; the correction commits first', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.hr.client, s.applicationId);
    const [corrected, demoted] = await holding([scoreRowsOf(s.applicationId)], async (end) => {
      const pending = correct(s.hr.client, s.applicationId, {
        ...unchanged(begin),
        scores: { [s.criteria[0]!.id]: 5 },
      });
      await waitingIn(WAITS.scoreUpdate); // past its locks, its rights check and its record
      const demotion = changeRole(s.hr.user.id, 'Employee');
      await waitingIn(WAITS.roleChangeTarget); // the role change waits for the corrector's staff row
      await end('COMMIT');
      return [await code(await pending), (await demotion).status];
    });
    expect(corrected[0]).toBe(200);
    expect(demoted).toBe(200);
    expect(await correctionAuditId(s.applicationId)).toBeLessThan(await auditId('employees', s.hr.user.id, 'UPDATE'));
    // Now an Employee who is not the mentor: no longer an evaluator.
    const again = await start(s.mentor.client, s.applicationId);
    expect((await correct(s.hr.client, s.applicationId, { ...unchanged(again), comment: 'After' })).status).toBe(404);
    await setRole(s.hr.email, 'HR', isolated.ownerUrl);
  });

  it('C1. the correction holds its locks first: the responsible HR replacement waits, then applies', async () => {
    const s = await submitted(1, [3]);
    const next = await signInStaff(api, 'HR');
    const begin = await start(s.hr.client, s.applicationId);
    const [corrected, replaced] = await holding([scoreRowsOf(s.applicationId)], async (end) => {
      const pending = correct(s.hr.client, s.applicationId, {
        ...unchanged(begin),
        scores: { [s.criteria[0]!.id]: 1 },
      });
      await waitingIn(WAITS.scoreUpdate);
      const replacement = replaceResponsibleHr(s.applicationId, next.user.id);
      await waitingIn(WAITS.replacementApplication); // waits for the correction's SHARE lock on the application
      await end('COMMIT');
      return [await code(await pending), (await replacement).status];
    });
    expect([corrected[0], replaced]).toEqual([200, 200]);
    const again = await start(next.client, s.applicationId);
    expect((await correct(s.hr.client, s.applicationId, { ...unchanged(again), comment: 'Replaced' })).status).toBe(
      404,
    );
    expect((await correct(next.client, s.applicationId, { ...unchanged(again), comment: 'New HR' })).status).toBe(200);
  });

  it('C2. the replacement holds the application first: the correction waits, then gets 404; nothing written', async () => {
    const s = await submitted(1, [3]);
    const next = await signInStaff(api, 'HR');
    const begin = await start(s.hr.client, s.applicationId);
    const before = await trace(s.applicationId);
    const lockCandidate: [string, unknown[]] = ['SELECT id FROM employees WHERE id = $1 FOR UPDATE', [next.user.id]];
    const [replaced, corrected] = await holding([lockCandidate], async (end) => {
      // The real replacement locks the application (FOR NO KEY UPDATE), then waits here for the new HR's staff row.
      const replacement = replaceResponsibleHr(s.applicationId, next.user.id);
      await waitingIn(WAITS.replacementCandidate);
      const pending = correct(s.hr.client, s.applicationId, { ...unchanged(begin), comment: 'Too late' });
      await waitingIn(WAITS.applicationShare); // the correction waits for the replacement's application lock
      await end('COMMIT');
      return [(await replacement).status, await code(await pending)];
    });
    expect(replaced).toBe(200);
    expect(corrected[0]).toBe(404);
    expect(await trace(s.applicationId)).toEqual(before);
  });

  it('D1. promoted to Admin before the correction locks the staff row: 403, nothing written', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.mentor.client, s.applicationId);
    const before = await trace(s.applicationId);
    const result = await holdingEvaluation(s.applicationId, async (end) => {
      const pending = correct(s.mentor.client, s.applicationId, { ...unchanged(begin), comment: 'As Admin' });
      await waitingIn(WAITS.evaluationUpdate);
      expect((await changeRole(s.mentor.user.id, 'Admin')).status).toBe(200);
      await end('COMMIT');
      return pending;
    });
    expect(result.status).toBe(403);
    expect(await trace(s.applicationId)).toEqual(before);
    expect((await changeRole(s.mentor.user.id, 'Employee')).status).toBe(200);
  });

  it('D2. a promotion to Admin after the correction locks the staff row waits until the correction commits', async () => {
    const s = await submitted(1, [3]);
    const begin = await start(s.mentor.client, s.applicationId);
    const [corrected, promoted] = await holding([scoreRowsOf(s.applicationId)], async (end) => {
      const pending = correct(s.mentor.client, s.applicationId, {
        ...unchanged(begin),
        scores: { [s.criteria[0]!.id]: 4 },
      });
      await waitingIn(WAITS.scoreUpdate);
      const promotion = changeRole(s.mentor.user.id, 'Admin');
      await waitingIn(WAITS.roleChangeTarget);
      await end('COMMIT');
      return [await code(await pending), (await promotion).status];
    });
    expect([corrected[0], promoted]).toEqual([200, 200]);
    expect(await correctionAuditId(s.applicationId)).toBeLessThan(
      await auditId('employees', s.mentor.user.id, 'UPDATE'),
    );
    const again = await start(s.hr.client, s.applicationId);
    expect((await correct(s.mentor.client, s.applicationId, { ...unchanged(again), comment: 'x' })).status).toBe(403);
    expect((await changeRole(s.mentor.user.id, 'Employee')).status).toBe(200);
  });

  it('E. a mentor transfer of the ended training is refused during a correction; the final mentor is unchanged', async () => {
    const s = await submitted(1, [3]);
    const other = await signInStaff(api, 'Employee');
    const begin = await start(s.mentor.client, s.applicationId);
    const assignments = () =>
      db((c) =>
        c.query('SELECT id, employee_id, status FROM assignments WHERE application_id = $1 ORDER BY created_at', [
          s.applicationId,
        ]),
      ).then((r) => r.rows);
    const before = await assignments();
    const [corrected, transfer] = await holding([scoreRowsOf(s.applicationId)], async (end) => {
      const pending = correct(s.mentor.client, s.applicationId, {
        ...unchanged(begin),
        scores: { [s.criteria[0]!.id]: 2 },
      });
      await waitingIn(WAITS.scoreUpdate);
      const moved = await s.hr.client.post(`/api/hr/assignments/${s.assignmentId}/transfer`, {
        employeeId: other.user.id,
        transferDate: today(),
        reason: 'Synthetic',
      });
      await end('COMMIT');
      return [await code(await pending), moved.status];
    });
    expect(corrected[0]).toBe(200);
    expect([400, 409]).toContain(transfer);
    expect(await assignments()).toEqual(before);
  });

  it('G. no deadlock with role changes, HR replacement, draft saves, submissions and assignment endings', async () => {
    const s = await submitted(1, [3]);
    const nextHr = await signInStaff(api, 'HR');
    const other = await endedTraining(); // another training, scored on the same active criterion
    const begin = await start(s.hr.client, s.applicationId);
    const outcome = await holding([scoreRowsOf(s.applicationId)], async (end) => {
      const pending = correct(s.hr.client, s.applicationId, {
        ...unchanged(begin),
        scores: { [s.criteria[0]!.id]: 5 },
      });
      await waitingIn(WAITS.scoreUpdate);
      const others = [
        changeRole(s.hr.user.id, 'HR'), // the same role: still locks the staff row (FOR NO KEY UPDATE)
        replaceResponsibleHr(s.applicationId, nextHr.user.id),
        s.mentor.client.put(`/api/evaluations/${s.applicationId}/draft`, {
          revision: begin.revision,
          comment: 'Draft on a submitted evaluation',
          hiringRecommendation: 'Yes',
          scores: {},
        }),
        (async () => {
          const saved = await other.mentor.client.put(`/api/evaluations/${other.applicationId}/draft`, {
            revision: 0,
            comment: 'Other training',
            hiringRecommendation: 'Maybe',
            scores: { [s.criteria[0]!.id]: 4 },
          });
          const d = await body<{ revision: number; criteriaVersion: string }>(saved);
          return other.hr.client.post(`/api/evaluations/${other.applicationId}/submit`, {
            revision: d.revision,
            criteriaVersion: d.criteriaVersion,
          });
        })(),
        s.hr.client.post(`/api/hr/assignments/${s.assignmentId}/complete`, { endDate: today(), reason: 'Again' }),
      ];
      await waitingIn(WAITS.roleChangeTarget);
      await waitingIn(WAITS.replacementApplication);
      await waitingIn(WAITS.evaluationUpdate); // the draft save on the same evaluation
      await end('COMMIT');
      return {
        corrected: await code(await pending),
        others: await Promise.all(others.map(async (p) => code(await p))),
      };
    });
    expect(outcome.corrected[0]).toBe(200);
    const [role, replacement, sameDraft, otherSubmit, ending] = outcome.others;
    expect([role![0], replacement![0], otherSubmit![0]]).toEqual([200, 200, 200]);
    expect(sameDraft).toEqual([409, 'evaluation.already_submitted']);
    expect([400, 409]).toContain(ending![0]);
    // A deadlock (40P01) would have answered 500 to one of them.
    expect([outcome.corrected, ...outcome.others].map((r) => r[0])).not.toContain(500);
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

// ── The database guards for the Worker's own role (ims_app) ──────────────────────────────────────────────────────

describe('final evaluation correction (S2.4): the database guards, as ims_app', () => {
  /** Runs `statements` as ims_app in one transaction acting as `actor`; returns the refusal's constraint, or 'committed'. */
  async function asApp(actor: string, statements: [string, unknown[]][]) {
    return withDb(async (c) => {
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('ims.actor_type', 'Staff', true), set_config('ims.actor_id', $1, true)", [
          actor,
        ]);
        for (const [text, params] of statements) await c.query(text, params);
        await c.query('COMMIT');
        return 'committed';
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (error as { constraint?: string }).constraint ?? String(error);
      }
    }, isolated.appUrl);
  }
  const evaluationOf = (applicationId: string) =>
    db((c) => c.query<{ id: string }>('SELECT id FROM evaluations WHERE application_id = $1', [applicationId])).then(
      (r) => r.rows[0]!.id,
    );
  const record = (evaluation: string, by: string): [string, unknown[]] => [
    'INSERT INTO evaluation_corrections (id, evaluation_id, corrected_by_id, corrected_at) VALUES (gen_random_uuid(), $1, $2, now())',
    [evaluation, by],
  ];
  const comment = (evaluation: string, value: string): [string, unknown[]] => [
    'UPDATE evaluations SET comment = $2 WHERE id = $1',
    [evaluation, value],
  ];

  it('a change without a record, or after the record is rolled back to a savepoint, is refused', async () => {
    const s = await submitted(1, [3]);
    const e = await evaluationOf(s.applicationId);
    expect(await asApp(s.mentor.user.id, [comment(e, 'No record')])).toBe('evaluations_submitted_readonly');
    expect(
      await asApp(s.mentor.user.id, [
        ['SAVEPOINT before_record', []],
        record(e, s.mentor.user.id),
        ['ROLLBACK TO SAVEPOINT before_record', []],
        comment(e, 'Record rolled back'),
      ]),
    ).toBe('evaluations_submitted_readonly');
    expect(
      await asApp(s.mentor.user.id, [
        record(e, s.mentor.user.id),
        ['UPDATE evaluation_scores SET score = 5 WHERE evaluation_id = $1', [e]],
        ['SAVEPOINT after', []],
        comment(e, 'Kept'),
        ['ROLLBACK TO SAVEPOINT after', []],
      ]),
    ).toBe('committed'); // the score change is the net change
    expect(await stored(s.applicationId)).toMatchObject({ comment: 'Submitted comment', corrections: 1 });
  });

  it('H1 and H2: the actor, one record per transaction, a net change at commit', async () => {
    const s = await submitted(1, [3]);
    const e = await evaluationOf(s.applicationId);
    expect(await asApp(s.mentor.user.id, [record(e, s.hr.user.id), comment(e, 'x')])).toBe(
      'evaluation_corrections_actor',
    );
    expect(await asApp(s.mentor.user.id, [record(e, s.mentor.user.id), record(e, s.mentor.user.id)])).toBe(
      'evaluation_corrections_one_per_transaction',
    );
    expect(await asApp(s.mentor.user.id, [record(e, s.mentor.user.id)])).toBe('evaluation_corrections_net_change');
    expect(
      await asApp(s.mentor.user.id, [record(e, s.mentor.user.id), comment(e, 'x'), comment(e, 'Submitted comment')]),
    ).toBe('evaluation_corrections_net_change');
    expect(
      await asApp(s.mentor.user.id, [
        record(e, s.mentor.user.id),
        ['UPDATE evaluations SET submitted_at = now() WHERE id = $1', [e]],
      ]),
    ).toBe('evaluations_submission_immutable');
    expect(
      await asApp(s.mentor.user.id, [
        record(e, s.mentor.user.id),
        ["UPDATE evaluation_scores SET frozen_name_en = 'Renamed' WHERE evaluation_id = $1", [e]],
      ]),
    ).toBe('evaluation_scores_snapshot_immutable');
    expect(await stored(s.applicationId)).toMatchObject({ comment: 'Submitted comment', corrections: 0 });
  });
});

// ── The domain rules and the refusal mapping ─────────────────────────────────────────────────────────────────────

describe('correctionInput, correctionDiff and correctionRefusal', () => {
  const k = '0190aaaa-0000-7000-8000-000000000001';
  const value = { revision: 3, comment: 'c', hiringRecommendation: 'Yes', scores: { [k]: 3 }, reason: null };
  const present = ['revision', 'comment', 'hiringrecommendation', 'scores', 'reason'];

  it('requires every field, a comment and a recommendation; trims the reason; 2,000 code points at most', () => {
    expect(() => correctionInput(value, present.slice(0, 4))).toThrow(DomainError);
    expect(() => correctionInput({ ...value, comment: ' ' }, present)).toThrow(DomainError);
    expect(() => correctionInput({ ...value, hiringRecommendation: null }, present)).toThrow(DomainError);
    expect(correctionInput({ ...value, reason: '  why  ' }, present).reason).toBe('why');
    expect(correctionInput({ ...value, reason: '😀'.repeat(2000) }, present).reason).toHaveLength(4000);
    expect(() => correctionInput({ ...value, reason: '😀'.repeat(2001) }, present)).toThrow(DomainError);
  });

  it('the diff needs exactly the frozen criteria and ignores the reason', () => {
    const current = { comment: 'c', hiringRecommendation: 'Yes', scores: new Map([[k, 3]]) };
    const input = correctionInput({ ...value, reason: 'only' }, present);
    expect(correctionDiff(current, input)).toEqual({ comment: false, hiringRecommendation: false, scores: new Map() });
    expect(() => correctionDiff({ ...current, scores: new Map() }, input)).toThrow(DomainError);
    expect(correctionDiff(current, correctionInput({ ...value, scores: { [k]: 4 } }, present)).scores).toEqual(
      new Map([[k, 4]]),
    );
  });

  it.each([
    ['evaluation_corrections_net_change', 'evaluation.no_changes'],
    ['evaluation_corrections_submitted_only', 'evaluation.not_submitted'],
  ])('maps %s to 409 %s', (constraint, expected) => {
    const mapped = correctionRefusal(Object.assign(new Error('x'), { code: '23001', constraint }));
    expect(mapped).toBeInstanceOf(StateConflictError);
    expect((mapped as StateConflictError).code).toBe(expected);
  });

  it.each([
    ['the actor guard', { code: '23001', constraint: 'evaluation_corrections_actor' }],
    ['the read-only guard', { code: '23001', constraint: 'evaluations_submitted_readonly' }],
    ['a lost connection', { code: '08006' }],
  ])('lets %s through unchanged (an error, never a success)', (_label, shape) => {
    const error = Object.assign(new Error('x'), shape);
    const mapped = correctionRefusal(error);
    expect(mapped).toBe(error);
    expect(mapped).not.toBeInstanceOf(ConcurrencyError);
  });
});
