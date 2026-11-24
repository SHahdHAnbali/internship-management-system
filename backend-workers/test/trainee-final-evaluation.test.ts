import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { calendarDate } from '../src/domain/training';
import { body, signInStaff, signInTrainee, type TestApi, type TestClient, withDb } from './helpers';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-database';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * The trainee's final evaluation result, stage S2.5 (R27, R14; owner decisions of 2026-11-24): on the status board
 * (`GET /api/trainee/applications`) an application whose final evaluation was **submitted** carries
 * `finalEvaluation: { submittedAt, grade }` and nothing else. The grade is the verbal grade of the current frozen scores
 * (so a correction shows at once), or null for a comment-only evaluation; `submittedAt` is the original submission time.
 * Before the submission, the application has no evaluation field at all: a draft is indistinguishable from no
 * evaluation. The trainee still gets 403 from every evaluator endpoint; nothing notifies or e-mails the trainee.
 *
 * A submission needs a score for every active criterion and the comment-only case needs none active, so this file runs
 * on a database of its own in the disposable container (alternative B, test/isolated-database.ts); its tests run in order.
 */
let isolated: IsolatedDatabase;
let api: TestApi;
let admin: { client: TestClient; user: { id: string }; email: string };

beforeAll(async () => {
  isolated = await createIsolatedDatabase();
  // Event e-mails on, so that any e-mail to the trainee would be captured (none is expected).
  api = isolated.api({}, { EVENT_EMAILS: 'enabled' });
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
}
interface FinalEvaluation {
  submittedAt: string;
  grade: string | null;
}
interface BoardEntry {
  id: string;
  status: string;
  finalEvaluation?: FinalEvaluation;
  [key: string]: unknown;
}
interface Detail {
  revision: number;
  criteriaVersion: string;
  submission?: { submittedAt: string; grade: string | null };
}
type Trainee = Awaited<ReturnType<typeof signInTrainee>>;

/** The status board as JSON text (to compare byte for byte) and parsed. */
async function boardText(trainee: TestClient) {
  const response = await trainee.get('/api/trainee/applications');
  expect(response.status).toBe(200);
  return response.text();
}
async function boardEntry(trainee: TestClient, applicationId: string) {
  const entries = JSON.parse(await boardText(trainee)) as BoardEntry[];
  return entries.find((e) => e.id === applicationId)!;
}

/** Only `count` active criteria, this test's own (the ones before are deactivated, never deleted). */
async function freshCriteria(count: number): Promise<Criterion[]> {
  const active = await db((c) =>
    c.query<Criterion>('SELECT id, name_ar AS "nameAr", name_en AS "nameEn" FROM evaluation_criteria WHERE is_active'),
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

/** An accepted application of `trainee` (a new one unless given) with an Active training by an Employee mentor. */
async function activeTraining(trainee?: Trainee) {
  const hr = await signInStaff(api, 'HR');
  const mentor = await signInStaff(api, 'Employee');
  const t = trainee ?? (await signInTrainee(api));
  const applicationId = await submitApplication(t.client, (await newField(admin.client)).id, 'Grade Trainee');
  expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  const assignmentId = await seedAssignment(
    applicationId,
    mentor.user.id,
    addDays(today(), -30),
    addDays(today(), 30),
    'Active',
    isolated.ownerUrl,
  );
  return { hr, mentor, trainee: t, applicationId, assignmentId };
}

/** The same, ended early today by its HR: the evaluation is available. */
async function endedTraining(trainee?: Trainee) {
  const t = await activeTraining(trainee);
  const ended = await t.hr.client.post(`/api/hr/assignments/${t.assignmentId}/complete`, {
    endDate: today(),
    reason: 'Synthetic early end',
  });
  expect(ended.status).toBe(200);
  return t;
}

type Ended = Awaited<ReturnType<typeof endedTraining>>;

/** The mentor saves a draft with `scores` (by criterion order) and a comment; returns the saved detail. */
async function saveDraft(
  t: Ended,
  criteria: Criterion[],
  scores: number[],
  revision = 0,
  by: TestClient = t.mentor.client,
) {
  const saved = await by.put(`/api/evaluations/${t.applicationId}/draft`, {
    revision,
    comment: 'Confidential evaluator comment',
    hiringRecommendation: 'Yes',
    scores: Object.fromEntries(criteria.map((c, i) => [c.id, scores[i]!])),
  });
  expect(saved.status).toBe(200);
  return body<Detail>(saved);
}

async function submit(t: Ended, draft: Detail) {
  const done = await t.mentor.client.post(`/api/evaluations/${t.applicationId}/submit`, {
    revision: draft.revision,
    criteriaVersion: draft.criteriaVersion,
  });
  expect(done.status).toBe(200);
  return body<Detail>(done);
}

/** A training whose evaluation was submitted with `scores` (`count` fresh criteria). */
async function submitted(count: number, scores: number[] = [], trainee?: Trainee) {
  const criteria = await freshCriteria(count);
  const t = await endedTraining(trainee);
  const detail = await submit(t, await saveDraft(t, criteria, scores));
  return { ...t, criteria, detail };
}

const storedSubmittedAt = (applicationId: string) =>
  db((c) =>
    c.query<{ submitted_at: Date }>('SELECT submitted_at FROM evaluations WHERE application_id = $1', [applicationId]),
  ).then((r) => r.rows[0]!.submitted_at.toISOString());

/** A correction by the mentor that sets the given scores (the rest unchanged). */
async function correctScores(t: Ended, scores: Record<string, number>, reason: string | null = null) {
  const begin = await t.mentor.client.get(`/api/evaluations/${t.applicationId}/correction`);
  expect(begin.status).toBe(200);
  const s = await body<{
    revision: number;
    comment: string;
    hiringRecommendation: string;
    scores: Record<string, number>;
  }>(begin);
  const response = await t.mentor.client.post(`/api/evaluations/${t.applicationId}/corrections`, {
    revision: s.revision,
    comment: s.comment,
    hiringRecommendation: s.hiringRecommendation,
    scores: { ...s.scores, ...scores },
    reason,
  });
  expect(response.status).toBe(200);
}

const count = (sql: string, values: unknown[] = []) =>
  db((c) => c.query<{ n: number }>(sql, values)).then((r) => r.rows[0]!.n);

describe('trainee final evaluation (S2.5): nothing before the submission', () => {
  it('no evaluation field in any state before submission; a saved draft changes the board by not one byte', async () => {
    const criteria = await freshCriteria(2);
    const t = await activeTraining();
    const active = await boardEntry(t.trainee.client, t.applicationId);
    expect(active.status).toBe('Accepted');
    expect('finalEvaluation' in active).toBe(false);

    const ended = await t.hr.client.post(`/api/hr/assignments/${t.assignmentId}/complete`, {
      endDate: today(),
      reason: 'Synthetic early end',
    });
    expect(ended.status).toBe(200);
    const afterEnd = await boardText(t.trainee.client);
    expect(afterEnd).not.toMatch(/finalEvaluation|grade|draft|evaluat/i);

    const mentorDraft = await saveDraft(t as Ended, criteria, [5, 5]);
    expect(await boardText(t.trainee.client)).toBe(afterEnd);
    // The responsible HR edits the shared draft too: still identical.
    await saveDraft(t as Ended, criteria, [1, 2], mentorDraft.revision, t.hr.client);
    expect(await boardText(t.trainee.client)).toBe(afterEnd);
    expect(
      await count("SELECT count(*)::int AS n FROM evaluations WHERE application_id = $1 AND status = 'Draft'", [
        t.applicationId,
      ]),
    ).toBe(1);
  });

  it('other lifecycle states (submitted, rejected, a Withdrawn training) carry no evaluation field', async () => {
    const hr = await signInStaff(api, 'HR');
    const mentor = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const field = (await newField(admin.client)).id;
    const waiting = await submitApplication(trainee.client, field, 'Grade Trainee');
    const refused = await submitApplication(trainee.client, field, 'Grade Trainee');
    expect((await hr.client.post(`/api/hr/applications/${refused}/reject`, { reason: 'Synthetic' })).status).toBe(200);
    const withdrawn = await submitApplication(trainee.client, field, 'Grade Trainee');
    expect((await hr.client.post(`/api/hr/applications/${withdrawn}/accept`)).status).toBe(200);
    await seedAssignment(withdrawn, mentor.user.id, addDays(today(), -30), today(), 'Withdrawn', isolated.ownerUrl);
    const text = await boardText(trainee.client);
    const entries = JSON.parse(text) as BoardEntry[];
    expect(entries.map((e) => e.id).sort()).toEqual([waiting, refused, withdrawn].sort());
    expect(entries.every((e) => !('finalEvaluation' in e))).toBe(true);
    expect(text).not.toMatch(/finalEvaluation|grade|evaluat/i);
  });
});

describe('trainee final evaluation (S2.5): after the submission', () => {
  it.each([
    [[5, 5], 'Excellent'],
    [[5, 4], 'Excellent'], // 4.5: the Excellent boundary
    [[5, 3], 'VeryGood'], // 4.0: the Very Good boundary
    [[4, 4], 'VeryGood'],
    [[4, 3], 'Good'], // 3.5
    [[3, 3], 'Good'], // 3.0: the Good boundary
    [[3, 2], 'Pass'], // 2.5
    [[2, 2], 'Pass'], // 2.0: the Pass boundary
    [[2, 1], 'Poor'], // 1.5
    [[1, 1], 'Poor'],
  ])('scores %j give exactly { submittedAt, grade: %s }, the original submission time', async (scores, grade) => {
    const s = await submitted(2, scores);
    const entry = await boardEntry(s.trainee.client, s.applicationId);
    expect(entry.finalEvaluation).toEqual({ submittedAt: await storedSubmittedAt(s.applicationId), grade });
    expect(Object.keys(entry.finalEvaluation!).sort()).toEqual(['grade', 'submittedAt']);
    // The same grade and time as the evaluators see (one domain rule, verbalGrade).
    expect(entry.finalEvaluation).toEqual({
      submittedAt: s.detail.submission!.submittedAt,
      grade: s.detail.submission!.grade,
    });
  });

  it('a comment-only evaluation (no criterion): grade null, with the submission time', async () => {
    const s = await submitted(0);
    const entry = await boardEntry(s.trainee.client, s.applicationId);
    expect(entry.finalEvaluation).toEqual({ submittedAt: await storedSubmittedAt(s.applicationId), grade: null });
  });

  it('a correction shows its grade at once and keeps the submission time; nothing is sent to the trainee', async () => {
    const criteria = await freshCriteria(2);
    const t = await endedTraining();
    const draft = await saveDraft(t, criteria, [4, 4]);
    const emailsBefore = api.emails.sent.filter((m) => m.to === t.trainee.email).length;
    const notificationsBefore = await count('SELECT count(*)::int AS n FROM notifications');

    await submit(t, draft);
    const first = (await boardEntry(t.trainee.client, t.applicationId)).finalEvaluation!;
    expect(first.grade).toBe('VeryGood');

    await correctScores(t, { [criteria[1]!.id]: 5 }, 'Typed the wrong score'); // 4.5
    const corrected = (await boardEntry(t.trainee.client, t.applicationId)).finalEvaluation!;
    expect(corrected).toEqual({ submittedAt: first.submittedAt, grade: 'Excellent' });
    expect(corrected.submittedAt).toBe(await storedSubmittedAt(t.applicationId));

    await correctScores(t, { [criteria[0]!.id]: 1, [criteria[1]!.id]: 2 }); // 1.5
    expect((await boardEntry(t.trainee.client, t.applicationId)).finalEvaluation).toEqual({
      submittedAt: first.submittedAt,
      grade: 'Poor',
    });

    expect(api.emails.sent.filter((m) => m.to === t.trainee.email).length).toBe(emailsBefore);
    expect(await count('SELECT count(*)::int AS n FROM notifications')).toBe(notificationsBefore);
  });

  it('exposes nothing else: no scores, total, average, comment, recommendation, criteria, evaluator, ids or corrections', async () => {
    const s = await submitted(3, [5, 4, 4]); // VeryGood (13/3)
    await correctScores(s, { [s.criteria[2]!.id]: 3 }, 'Secret correction reason'); // 12/3 = 4.0
    const text = await boardText(s.trainee.client);
    const entry = (JSON.parse(text) as BoardEntry[]).find((e) => e.id === s.applicationId)!;
    expect(entry.finalEvaluation!.grade).toBe('VeryGood');
    const evaluationId = await db((c) =>
      c.query<{ id: string }>('SELECT id FROM evaluations WHERE application_id = $1', [s.applicationId]),
    ).then((r) => r.rows[0]!.id);
    const mentorName = await db((c) =>
      c.query<{ full_name: string }>('SELECT full_name FROM employees WHERE id = $1', [s.mentor.user.id]),
    ).then((r) => r.rows[0]!.full_name);
    for (const secret of [
      'Confidential evaluator comment',
      'Secret correction reason',
      evaluationId,
      mentorName,
      s.mentor.user.id,
      ...s.criteria.flatMap((c) => [c.id, c.nameEn, c.nameAr]),
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(
      /"(scores?|total|sum|scored|average|mean|comment|hiringRecommendation|criteria|submittedBy|latestCorrection|evaluationId|revision|version)"/i,
    );
    // Only a verbal grade and an ISO timestamp: no number at all.
    expect(entry.finalEvaluation).toEqual({
      submittedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      grade: 'VeryGood',
    });
  });
});

describe('trainee final evaluation (S2.5): isolation and refusals', () => {
  it('each application shows its own result; another trainee sees none of them', async () => {
    const trainee = await signInTrainee(api);
    const first = await submitted(2, [5, 5], trainee); // Excellent
    const second = await submitted(2, [1, 2], trainee); // Poor
    const notYet = await endedTraining(trainee); // ended, no evaluation
    const entries = JSON.parse(await boardText(trainee.client)) as BoardEntry[];
    const of = (id: string) => entries.find((e) => e.id === id)!;
    expect(of(first.applicationId).finalEvaluation!.grade).toBe('Excellent');
    expect(of(second.applicationId).finalEvaluation!.grade).toBe('Poor');
    expect('finalEvaluation' in of(notYet.applicationId)).toBe(false);

    const other = await signInTrainee(api);
    const otherApplication = await submitApplication(other.client, (await newField(admin.client)).id, 'Other');
    const text = await boardText(other.client);
    expect((JSON.parse(text) as BoardEntry[]).map((e) => e.id)).toEqual([otherApplication]);
    for (const id of [first.applicationId, second.applicationId, notYet.applicationId]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/finalEvaluation|grade/i);
  });

  it('the trainee still gets 403 from every evaluator endpoint, for their own application', async () => {
    const s = await submitted(1, [3]);
    const c = s.trainee.client;
    const id = s.applicationId;
    expect((await c.get('/api/evaluations')).status).toBe(403);
    expect((await c.get(`/api/evaluations/${id}`)).status).toBe(403);
    expect((await c.get(`/api/evaluations/${id}/correction`)).status).toBe(403);
    expect((await c.put(`/api/evaluations/${id}/draft`, { revision: 0, comment: 'x', scores: {} })).status).toBe(403);
    expect((await c.post(`/api/evaluations/${id}/submit`, { revision: 0, criteriaVersion: 'x' })).status).toBe(403);
    expect(
      (await c.post(`/api/evaluations/${id}/corrections`, { revision: 1, comment: 'x', scores: {}, reason: null }))
        .status,
    ).toBe(403);
  });

  it('reading the board writes nothing: no audit row', async () => {
    const s = await submitted(1, [4]);
    const before = await count('SELECT count(*)::int AS n FROM audit_logs');
    await boardText(s.trainee.client);
    await boardText(s.trainee.client);
    expect(await count('SELECT count(*)::int AS n FROM audit_logs')).toBe(before);
  });
});
