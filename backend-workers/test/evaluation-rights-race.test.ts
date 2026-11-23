import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { calendarDate } from '../src/domain/training';
import { body, setRole, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-database';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * The evaluators' rights while they save a draft (S2.2) or submit (S2.3), under concurrent role changes and responsible
 * HR replacements (owner decisions of 2026-11-23: solution C, the shared locked rights check). Within the same
 * transaction the training application is locked FOR SHARE, then the actor's staff row FOR SHARE; the rights are decided
 * from that locked state (a prohibited role → 403, no longer an evaluator → 404) before any evaluation write, and the
 * locks are held until COMMIT. So a role change (FOR NO KEY UPDATE on the staff row) and a replacement of the responsible
 * HR (FOR NO KEY UPDATE on the application) either wait for the evaluation write or are seen by it.
 *
 * A database of its own (alternative B, test/isolated-database.ts); its tests run in order. Every race is synchronized by
 * observed lock waits (the waiting statement's own SQL text), never by time.
 */
let isolated: IsolatedDatabase;
let api: TestApi;
let admin: { client: TestClient; user: { id: string }; email: string };
let criterion: string;

beforeAll(async () => {
  isolated = await createIsolatedDatabase();
  api = isolated.api();
  admin = await signInStaff(api, 'Admin');
  const created = await admin.client.post('/api/admin/evaluation-criteria', {
    nameAr: 'معيار الاختبار',
    nameEn: `Race ${crypto.randomUUID().slice(0, 8)}`,
  });
  expect(created.status).toBe(201);
  criterion = (await body<{ id: string }>(created)).id;
});

const db = <T>(work: (client: pg.Client) => Promise<T>) => withDb(work, isolated.ownerUrl);
const today = () => calendarDate(new Date());
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** An ended training (EndedEarly today): responsible HR = the accepting HR, final mentor = an Employee. */
async function endedTraining() {
  const hr = await signInStaff(api, 'HR');
  const mentor = await signInStaff(api, 'Employee');
  const trainee = await signInTrainee(api);
  const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Race Trainee');
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
  return { hr, mentor, applicationId, assignmentId };
}

type Training = Awaited<ReturnType<typeof endedTraining>>;
const code = async (response: Response) => [response.status, (await body<{ code?: string }>(response)).code];

/** What the evaluator sees now: the draft's revision and the criteria fingerprint. */
async function seen(client: TestClient, applicationId: string) {
  const response = await client.get(`/api/evaluations/${applicationId}`);
  expect(response.status).toBe(200);
  const d = await body<{ revision: number; criteriaVersion: string }>(response);
  return { revision: d.revision, criteriaVersion: d.criteriaVersion };
}
const saveDraft = (client: TestClient, applicationId: string, revision: number, comment: string) =>
  client.put(`/api/evaluations/${applicationId}/draft`, {
    revision,
    comment,
    hiringRecommendation: 'Maybe',
    scores: { [criterion]: 4 },
  });
/** A complete saved draft (by the mentor), so that the training can be submitted. */
async function completeDraft(t: Training) {
  const response = await saveDraft(t.mentor.client, t.applicationId, 0, 'Complete draft');
  expect(response.status).toBe(200);
  return seen(t.mentor.client, t.applicationId);
}
const submit = (client: TestClient, applicationId: string, s: { revision: number; criteriaVersion: string }) =>
  client.post(`/api/evaluations/${applicationId}/submit`, s);
const changeRole = (employeeId: string, role: string) =>
  admin.client.put(`/api/admin/users/${employeeId}/role`, { role });
const replaceResponsibleHr = (applicationId: string, hrId: string) =>
  admin.client.put(`/api/admin/accepted-trainees/${applicationId}/responsible-hr`, { hrId });

// ── Lock observation (this database is this file's alone, and its tests run in order) ─────────────────────────────

/** The statements each side waits in (the exact SQL of the code under test). */
const WAITS = {
  applicationShare: 'SELECT id FROM training_applications WHERE id = $1 FOR SHARE',
  draftEvaluationLock: 'SELECT id, status, version FROM evaluations WHERE application_id = $1 FOR UPDATE',
  draftInsert: 'INSERT INTO evaluations (id, application_id, assignment_id, status, created_at, updated_at)',
  submissionCriteriaLock: 'LOCK TABLE evaluation_criteria IN SHARE MODE',
  roleChangeTarget: 'FROM employees WHERE id = $1 FOR NO KEY UPDATE',
  replacementApplication: 'SELECT status FROM training_applications WHERE id = $1 FOR NO KEY UPDATE',
  replacementCandidate: 'SELECT role FROM employees WHERE id = $1 FOR SHARE',
};

const waiting = (sql: string) =>
  db((c) =>
    c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND strpos(query, $1) > 0`,
      [sql],
    ),
  ).then((r) => r.rows[0]!.n);

/** Resolves once `count` sessions wait for a lock in a statement containing `sql`; fails after 20 s. */
async function waitingIn(sql: string, count = 1) {
  for (let i = 0; i < 1000; i++) {
    if ((await waiting(sql)) >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Expected ${count} session(s) waiting for a lock in: ${sql}`);
}

/**
 * Whether a request is seen waiting for a lock in `sql`, or finishes first (it took no conflicting lock). Used for the
 * operations that must wait for the evaluation write's authorization locks; "finished" is the unprotected behavior.
 */
async function waitsOrFinishes(request: Promise<Response>, sql: string): Promise<'waits' | 'finishes'> {
  let finished = false;
  request.then(
    () => (finished = true),
    () => (finished = true),
  );
  for (let i = 0; i < 1000; i++) {
    if ((await waiting(sql)) >= 1) return 'waits';
    if (finished) return 'finishes';
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Neither waiting in nor finished: ${sql}`);
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
const lockEvaluation = (applicationId: string): [string, unknown[]] => [
  'SELECT id FROM evaluations WHERE application_id = $1 FOR UPDATE',
  [applicationId],
];
const lockApplication = (applicationId: string): [string, unknown[]] => [
  'SELECT id FROM training_applications WHERE id = $1 FOR UPDATE',
  [applicationId],
];
/** The FOR UPDATE row lock makes the first draft's INSERT wait at its foreign-key check (KEY SHARE). */
const lockAssignment = (assignmentId: string): [string, unknown[]] => [
  'SELECT id FROM assignments WHERE id = $1 FOR UPDATE',
  [assignmentId],
];
/** ROW EXCLUSIVE on the criteria: a submission waits at its SHARE table lock, after its rights check. */
const lockCriteriaTable: [string, unknown[]] = ['LOCK TABLE evaluation_criteria IN ROW EXCLUSIVE MODE', []];
const lockStaffRow = (employeeId: string): [string, unknown[]] => [
  'SELECT id FROM employees WHERE id = $1 FOR UPDATE',
  [employeeId],
];

/** The latest audit number of a write, to prove which of two transactions committed first. */
const auditId = (table: string, entityId: string) =>
  db((c) =>
    c.query<{ id: string | null }>(
      "SELECT max(id)::text AS id FROM audit_logs WHERE table_name = $1 AND entity_id = $2 AND operation IN ('INSERT', 'UPDATE')",
      [table, entityId],
    ),
  ).then((r) => (r.rows[0]!.id === null ? null : BigInt(r.rows[0]!.id)));
const evaluationId = (applicationId: string) =>
  db((c) => c.query<{ id: string }>('SELECT id FROM evaluations WHERE application_id = $1', [applicationId])).then(
    (r) => r.rows[0]?.id ?? null,
  );

/**
 * Everything an evaluation write could leave for this training: the evaluation row, its scores (with the snapshot), and
 * every audit row of the evaluation and its scores. A refused request leaves it exactly as it was.
 */
const trace = (applicationId: string) =>
  db((c) =>
    c.query(
      `SELECT (SELECT json_agg(json_build_object('id', e.id, 'status', e.status, 'version', e.version, 'comment', e.comment,
                                                 'by', e.submitted_by_id, 'at', e.submitted_at))
                 FROM evaluations e WHERE e.application_id = $1) AS evaluation,
              (SELECT json_agg(json_build_object('score', s.score, 'frozen', s.frozen_sort_order) ORDER BY s.id)
                 FROM evaluation_scores s JOIN evaluations e ON e.id = s.evaluation_id WHERE e.application_id = $1) AS scores,
              (SELECT count(*)::int FROM audit_logs a
                WHERE (a.table_name = 'evaluations' AND (a.new_values ->> 'application_id' = $1::text
                         OR a.entity_id IN (SELECT e.id::text FROM evaluations e WHERE e.application_id = $1)))
                   OR (a.table_name = 'evaluation_scores' AND a.entity_id IN (
                         SELECT s.id::text FROM evaluation_scores s JOIN evaluations e ON e.id = s.evaluation_id
                          WHERE e.application_id = $1))) AS audits`,
      [applicationId],
    ),
  ).then((r) => r.rows[0] as Record<string, unknown>);

// ── S2.2: the shared draft ───────────────────────────────────────────────────────────────────────────────────────

describe('S2.2 draft save: the rights are decided under locks held until COMMIT', () => {
  it('HR demoted after the rights check (draft exists): the demotion waits; the save commits first', async () => {
    const t = await endedTraining();
    await completeDraft(t);
    const { revision } = await seen(t.hr.client, t.applicationId);
    const facts = await holding([lockEvaluation(t.applicationId)], async (end) => {
      const save = saveDraft(t.hr.client, t.applicationId, revision, 'Saved by HR');
      await waitingIn(WAITS.draftEvaluationLock); // past its rights check, waiting for the evaluation row
      const demotion = changeRole(t.hr.user.id, 'Employee');
      const demotionOutcome = await waitsOrFinishes(demotion, WAITS.roleChangeTarget);
      await end('COMMIT');
      return { demotionOutcome, save: (await save).status, demotion: (await demotion).status };
    });
    const evaluation = (await evaluationId(t.applicationId))!;
    const staleWriteAfterRevocation =
      facts.save === 200 && (await auditId('employees', t.hr.user.id))! < (await auditId('evaluations', evaluation))!;
    expect({ ...facts, staleWriteAfterRevocation }).toEqual({
      demotionOutcome: 'waits',
      save: 200,
      demotion: 200,
      staleWriteAfterRevocation: false,
    });
    await setRole(t.hr.email, 'HR', isolated.ownerUrl);
  });

  it('first draft (no evaluation row yet): a demotion after the rights check waits; the first save commits first', async () => {
    const t = await endedTraining();
    const facts = await holding([lockAssignment(t.assignmentId)], async (end) => {
      const save = saveDraft(t.hr.client, t.applicationId, 0, 'First draft by HR');
      await waitingIn(WAITS.draftInsert); // past its rights check, its INSERT waiting at the foreign-key check
      const demotion = changeRole(t.hr.user.id, 'Employee');
      const demotionOutcome = await waitsOrFinishes(demotion, WAITS.roleChangeTarget);
      await end('COMMIT');
      return { demotionOutcome, save: (await save).status, demotion: (await demotion).status };
    });
    const evaluation = await evaluationId(t.applicationId);
    const staleWriteAfterRevocation =
      facts.save === 200 &&
      evaluation !== null &&
      (await auditId('employees', t.hr.user.id))! < (await auditId('evaluations', evaluation))!;
    expect({ ...facts, staleWriteAfterRevocation }).toEqual({
      demotionOutcome: 'waits',
      save: 200,
      demotion: 200,
      staleWriteAfterRevocation: false,
    });
    await setRole(t.hr.email, 'HR', isolated.ownerUrl);
  });

  it('first draft: HR demoted while the save waits for the application → 404; no evaluation row, no audit', async () => {
    const t = await endedTraining();
    const before = await trace(t.applicationId);
    const result = await holding([lockApplication(t.applicationId)], async (end) => {
      const save = saveDraft(t.hr.client, t.applicationId, 0, 'Too late');
      const saveOutcome = await waitsOrFinishes(save, WAITS.applicationShare);
      expect((await changeRole(t.hr.user.id, 'Employee')).status).toBe(200); // the staff row is not locked yet
      await end('COMMIT');
      return { saveOutcome, save: await code(await save) };
    });
    expect({ ...result, after: await trace(t.applicationId) }).toEqual({
      saveOutcome: 'waits',
      save: [404, 'not_found'],
      after: before,
    });
    await setRole(t.hr.email, 'HR', isolated.ownerUrl);
  });

  it('mentor promoted to Admin while the save waits → 403; promoted after the locks → the promotion waits', async () => {
    const t = await endedTraining();
    await completeDraft(t);
    let { revision } = await seen(t.mentor.client, t.applicationId);
    const before = await trace(t.applicationId);
    const refused = await holding([lockApplication(t.applicationId)], async (end) => {
      const save = saveDraft(t.mentor.client, t.applicationId, revision, 'As Admin');
      const saveOutcome = await waitsOrFinishes(save, WAITS.applicationShare);
      expect((await changeRole(t.mentor.user.id, 'Admin')).status).toBe(200);
      await end('COMMIT');
      return { saveOutcome, status: (await save).status };
    });
    expect({ ...refused, after: await trace(t.applicationId) }).toEqual({
      saveOutcome: 'waits',
      status: 403,
      after: before,
    });
    expect((await changeRole(t.mentor.user.id, 'Employee')).status).toBe(200);

    ({ revision } = await seen(t.mentor.client, t.applicationId));
    const facts = await holding([lockEvaluation(t.applicationId)], async (end) => {
      const save = saveDraft(t.mentor.client, t.applicationId, revision, 'Before the promotion');
      await waitingIn(WAITS.draftEvaluationLock);
      const promotion = changeRole(t.mentor.user.id, 'Admin');
      const promotionOutcome = await waitsOrFinishes(promotion, WAITS.roleChangeTarget);
      await end('COMMIT');
      return { promotionOutcome, save: (await save).status, promotion: (await promotion).status };
    });
    expect(facts).toEqual({ promotionOutcome: 'waits', save: 200, promotion: 200 });
    expect((await changeRole(t.mentor.user.id, 'Employee')).status).toBe(200);
  });

  it('responsible HR replacement, the save first: the replacement waits; the save is the old HR’s, then 404', async () => {
    const t = await endedTraining();
    await completeDraft(t);
    const next = await signInStaff(api, 'HR');
    const { revision } = await seen(t.hr.client, t.applicationId);
    const facts = await holding([lockEvaluation(t.applicationId)], async (end) => {
      const save = saveDraft(t.hr.client, t.applicationId, revision, 'Old HR');
      await waitingIn(WAITS.draftEvaluationLock);
      const replacement = replaceResponsibleHr(t.applicationId, next.user.id);
      const replacementOutcome = await waitsOrFinishes(replacement, WAITS.replacementApplication);
      await end('COMMIT');
      return { replacementOutcome, save: (await save).status, replacement: (await replacement).status };
    });
    expect(facts).toEqual({ replacementOutcome: 'waits', save: 200, replacement: 200 });
    const again = await seen(next.client, t.applicationId);
    expect((await saveDraft(t.hr.client, t.applicationId, again.revision, 'Replaced')).status).toBe(404);
    expect((await saveDraft(next.client, t.applicationId, again.revision, 'New HR')).status).toBe(200);
  });

  it('responsible HR replacement holding the application first: the save waits, then 404; nothing written', async () => {
    const t = await endedTraining();
    await completeDraft(t);
    const next = await signInStaff(api, 'HR');
    const { revision } = await seen(t.hr.client, t.applicationId);
    const before = await trace(t.applicationId);
    const facts = await holding([lockStaffRow(next.user.id)], async (end) => {
      // The real replacement locks the application (FOR NO KEY UPDATE), then waits here for the new HR's staff row.
      const replacement = replaceResponsibleHr(t.applicationId, next.user.id);
      await waitingIn(WAITS.replacementCandidate);
      const save = saveDraft(t.hr.client, t.applicationId, revision, 'Too late');
      const saveOutcome = await waitsOrFinishes(save, WAITS.applicationShare);
      await end('COMMIT');
      return { saveOutcome, replacement: (await replacement).status, save: await code(await save) };
    });
    expect({ ...facts, after: await trace(t.applicationId) }).toEqual({
      saveOutcome: 'waits',
      replacement: 200,
      save: [404, 'not_found'],
      after: before,
    });
  });
});

// ── S2.3: the submission ─────────────────────────────────────────────────────────────────────────────────────────

describe('S2.3 submission: the rights are decided under locks held until COMMIT', () => {
  it('HR demoted after the rights check: the demotion waits; the submission (by the HR) commits first', async () => {
    const t = await endedTraining();
    const s = await completeDraft(t);
    const facts = await holding([lockCriteriaTable], async (end) => {
      const submission = submit(t.hr.client, t.applicationId, s);
      await waitingIn(WAITS.submissionCriteriaLock); // past its rights check and the evaluation lock
      const demotion = changeRole(t.hr.user.id, 'Employee');
      const demotionOutcome = await waitsOrFinishes(demotion, WAITS.roleChangeTarget);
      await end('ROLLBACK');
      return { demotionOutcome, submission: (await submission).status, demotion: (await demotion).status };
    });
    const evaluation = (await evaluationId(t.applicationId))!;
    const submittedBy = (await trace(t.applicationId)).evaluation as { by: string }[];
    const staleSubmitterAfterRevocation =
      facts.submission === 200 &&
      (await auditId('employees', t.hr.user.id))! < (await auditId('evaluations', evaluation))!;
    expect({ ...facts, submittedBy: submittedBy[0]!.by, staleSubmitterAfterRevocation }).toEqual({
      demotionOutcome: 'waits',
      submission: 200,
      demotion: 200,
      submittedBy: t.hr.user.id,
      staleSubmitterAfterRevocation: false,
    });
    await setRole(t.hr.email, 'HR', isolated.ownerUrl);
  });

  it('HR demoted while the submission waits for the application → 404; no submission, snapshot or audit', async () => {
    const t = await endedTraining();
    const s = await completeDraft(t);
    const before = await trace(t.applicationId);
    const result = await holding([lockApplication(t.applicationId)], async (end) => {
      const submission = submit(t.hr.client, t.applicationId, s);
      const submissionOutcome = await waitsOrFinishes(submission, WAITS.applicationShare);
      expect((await changeRole(t.hr.user.id, 'Employee')).status).toBe(200);
      await end('COMMIT');
      return { submissionOutcome, submission: await code(await submission) };
    });
    expect({ ...result, after: await trace(t.applicationId) }).toEqual({
      submissionOutcome: 'waits',
      submission: [404, 'not_found'],
      after: before,
    });
    await setRole(t.hr.email, 'HR', isolated.ownerUrl);
  });

  it('mentor promoted to Admin before the locks → 403, nothing submitted; after the locks → the promotion waits', async () => {
    const t = await endedTraining();
    const s = await completeDraft(t);
    const before = await trace(t.applicationId);
    const refused = await holding([lockApplication(t.applicationId)], async (end) => {
      const submission = submit(t.mentor.client, t.applicationId, s);
      const submissionOutcome = await waitsOrFinishes(submission, WAITS.applicationShare);
      expect((await changeRole(t.mentor.user.id, 'Admin')).status).toBe(200);
      await end('COMMIT');
      return { submissionOutcome, status: (await submission).status };
    });
    expect({ ...refused, after: await trace(t.applicationId) }).toEqual({
      submissionOutcome: 'waits',
      status: 403,
      after: before,
    });
    expect((await changeRole(t.mentor.user.id, 'Employee')).status).toBe(200);

    const facts = await holding([lockCriteriaTable], async (end) => {
      const submission = submit(t.mentor.client, t.applicationId, s);
      await waitingIn(WAITS.submissionCriteriaLock);
      const promotion = changeRole(t.mentor.user.id, 'Admin');
      const promotionOutcome = await waitsOrFinishes(promotion, WAITS.roleChangeTarget);
      await end('ROLLBACK');
      return { promotionOutcome, submission: (await submission).status, promotion: (await promotion).status };
    });
    expect(facts).toEqual({ promotionOutcome: 'waits', submission: 200, promotion: 200 });
    expect((await changeRole(t.mentor.user.id, 'Employee')).status).toBe(200);
  });

  it('responsible HR replacement, the submission first: the replacement waits; the old HR is the submitter', async () => {
    const t = await endedTraining();
    const s = await completeDraft(t);
    const next = await signInStaff(api, 'HR');
    const facts = await holding([lockCriteriaTable], async (end) => {
      const submission = submit(t.hr.client, t.applicationId, s);
      await waitingIn(WAITS.submissionCriteriaLock);
      const replacement = replaceResponsibleHr(t.applicationId, next.user.id);
      const replacementOutcome = await waitsOrFinishes(replacement, WAITS.replacementApplication);
      await end('ROLLBACK');
      return { replacementOutcome, submission: (await submission).status, replacement: (await replacement).status };
    });
    const evaluation = (await evaluationId(t.applicationId))!;
    const staleSubmitterAfterRevocation =
      facts.submission === 200 &&
      (await db((c) =>
        c.query<{ id: string }>(
          "SELECT max(id)::text AS id FROM audit_logs WHERE table_name = 'responsible_hr_changes' AND new_values ->> 'application_id' = $1",
          [t.applicationId],
        ),
      ).then((r) => BigInt(r.rows[0]!.id))) < (await auditId('evaluations', evaluation))!;
    expect({ ...facts, staleSubmitterAfterRevocation }).toEqual({
      replacementOutcome: 'waits',
      submission: 200,
      replacement: 200,
      staleSubmitterAfterRevocation: false,
    });
  });

  it('responsible HR replacement holding the application first: the submission waits, then 404; nothing written', async () => {
    const t = await endedTraining();
    const s = await completeDraft(t);
    const next = await signInStaff(api, 'HR');
    const before = await trace(t.applicationId);
    const facts = await holding([lockStaffRow(next.user.id)], async (end) => {
      const replacement = replaceResponsibleHr(t.applicationId, next.user.id);
      await waitingIn(WAITS.replacementCandidate);
      const submission = submit(t.hr.client, t.applicationId, s);
      const submissionOutcome = await waitsOrFinishes(submission, WAITS.applicationShare);
      await end('COMMIT');
      return { submissionOutcome, replacement: (await replacement).status, submission: await code(await submission) };
    });
    expect({ ...facts, after: await trace(t.applicationId) }).toEqual({
      submissionOutcome: 'waits',
      replacement: 200,
      submission: [404, 'not_found'],
      after: before,
    });
  });
});

// ── Overlapping work: no deadlock ────────────────────────────────────────────────────────────────────────────────

describe('draft saves, submissions, corrections, role changes, HR replacement and criteria updates together', () => {
  it('no deadlock (40P01 would answer 500): every request ends with its expected status', async () => {
    const saving = await endedTraining(); // a draft save paused while holding its locks
    const submitting = await endedTraining();
    const correcting = await endedTraining();
    await completeDraft(saving);
    const toSubmit = await completeDraft(submitting);
    const toCorrect = await completeDraft(correcting);
    expect((await submit(correcting.mentor.client, correcting.applicationId, toCorrect)).status).toBe(200);
    const correction = await body<{ revision: number; comment: string; scores: Record<string, number> }>(
      await correcting.mentor.client.get(`/api/evaluations/${correcting.applicationId}/correction`),
    );
    const nextHr = await signInStaff(api, 'HR');
    const { revision } = await seen(saving.hr.client, saving.applicationId);
    const criterionNames = await db((c) =>
      c.query<{ name_ar: string; name_en: string }>('SELECT name_ar, name_en FROM evaluation_criteria WHERE id = $1', [
        criterion,
      ]),
    ).then((r) => r.rows[0]!);

    const outcome = await holding([lockEvaluation(saving.applicationId)], async (end) => {
      const save = saveDraft(saving.hr.client, saving.applicationId, revision, 'Paused save');
      await waitingIn(WAITS.draftEvaluationLock);
      const others = [
        changeRole(saving.hr.user.id, 'HR'), // the same role: still locks the staff row (FOR NO KEY UPDATE)
        replaceResponsibleHr(saving.applicationId, nextHr.user.id),
        submit(submitting.mentor.client, submitting.applicationId, toSubmit),
        correcting.mentor.client.post(`/api/evaluations/${correcting.applicationId}/corrections`, {
          revision: correction.revision,
          comment: 'Corrected meanwhile',
          hiringRecommendation: 'Yes',
          scores: correction.scores,
          reason: null,
        }),
        admin.client.put(`/api/admin/evaluation-criteria/${criterion}`, {
          nameAr: criterionNames.name_ar,
          nameEn: criterionNames.name_en,
          isActive: true,
        }),
      ];
      await waitingIn(WAITS.roleChangeTarget);
      await waitingIn(WAITS.replacementApplication);
      await end('COMMIT');
      return {
        save: await code(await save),
        others: await Promise.all(others.map(async (p) => code(await p))),
      };
    });
    expect(outcome.save[0]).toBe(200);
    expect(outcome.others.map((r) => r[0])).toEqual([200, 200, 200, 200, 200]);
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
