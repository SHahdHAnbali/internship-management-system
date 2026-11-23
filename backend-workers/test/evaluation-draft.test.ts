import { describe, expect, it } from 'vitest';
import { calendarDate } from '../src/domain/training';
import { body, createTestApi, setRole, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * The shared final evaluation draft, stage S2.2 (R27; AD-66, AD-68 G2/G5/G8, AD-69 and the owner decisions of
 * 2026-11-22, AD-70): `PUT /api/evaluations/:id/draft` and the draft values in `GET /api/evaluations/:id`. One draft per
 * training application, created by its first save, edited by the final mentor and the current responsible HR (checked
 * at every request); incomplete is fine; scores are whole numbers 1–5 and a saved one is never cleared; criteria left
 * out keep their values; an inactive criterion keeps its score and shows it again when reactivated. Saves are atomic and
 * use the revision for optimistic concurrency (409 conflict.concurrent_update). Only the last-saved time is shown, never
 * who saved; no mean, no grade, no submission.
 */
const api = createTestApi();

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => calendarDate(new Date());

interface Detail {
  status: string;
  criteria: { id: string; nameAr: string; nameEn: string; sortOrder: number }[];
  revision?: number;
  draft?: {
    comment: string | null;
    hiringRecommendation: string | null;
    scores: Record<string, number>;
    lastSavedAt: string | null;
  };
}
interface Draft {
  revision: number;
  comment: string | null;
  hiringRecommendation: string | null;
  scores: Record<string, number>;
}

const empty: Draft = { revision: 0, comment: null, hiringRecommendation: null, scores: {} };
const problem = async (response: Response) => {
  const { traceId: _traceId, ...rest } = await body<Record<string, unknown>>(response);
  return rest;
};

/** An ended training (EndedEarly today): responsible HR = the accepting HR, final mentor = an Employee. */
async function endedTraining() {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const mentor = await signInStaff(api, 'Employee');
  const trainee = await signInTrainee(api);
  const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Draft Trainee');
  expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  const assignmentId = await seedAssignment(
    applicationId,
    mentor.user.id,
    addDays(today(), -30),
    addDays(today(), 30),
    'Active',
  );
  const ended = await hr.client.post(`/api/hr/assignments/${assignmentId}/complete`, {
    endDate: today(),
    reason: 'Synthetic early end',
  });
  expect(ended.status).toBe(200);
  return { admin, hr, mentor, trainee, applicationId, assignmentId };
}

/** A criterion of this test's own (active), so that toggling it touches nothing else. */
async function criterion(admin: TestClient) {
  return body<{ id: string; nameAr: string; nameEn: string }>(
    await admin.post('/api/admin/evaluation-criteria', {
      nameAr: 'معيار مسودة',
      nameEn: `Draft ${crypto.randomUUID()}`,
    }),
  );
}
const setActive = async (admin: TestClient, c: { id: string; nameAr: string; nameEn: string }, isActive: boolean) =>
  expect(
    (await admin.put(`/api/admin/evaluation-criteria/${c.id}`, { nameAr: c.nameAr, nameEn: c.nameEn, isActive }))
      .status,
  ).toBe(200);

const read = async (client: TestClient, applicationId: string) => {
  const response = await client.get(`/api/evaluations/${applicationId}`);
  expect(response.status).toBe(200);
  return body<Detail>(response);
};
const save = (client: TestClient, applicationId: string, draft: Record<string, unknown>) =>
  client.put(`/api/evaluations/${applicationId}/draft`, { ...empty, ...draft });

const stored = (applicationId: string) =>
  withDb((db) =>
    db.query<{
      status: string;
      version: number;
      comment: string | null;
      recommendation: string | null;
      updated_at: Date;
      assignment_id: string;
      scores: Record<string, number> | null;
    }>(
      `SELECT e.status, e.version, e.comment, e.hiring_recommendation AS recommendation, e.updated_at, e.assignment_id,
              (SELECT jsonb_object_agg(s.criterion_id, s.score) FROM evaluation_scores s WHERE s.evaluation_id = e.id) AS scores
         FROM evaluations e WHERE e.application_id = $1`,
      [applicationId],
    ),
  ).then((r) => r.rows);

describe('final evaluation draft (S2.2): reading', () => {
  it('a training not started has revision 0, an empty draft and no last-saved time', async () => {
    const t = await endedTraining();
    const d = await read(t.mentor.client, t.applicationId);

    expect(d.status).toBe('NotStarted');
    expect(d.revision).toBe(0);
    expect(d.draft).toEqual({ comment: null, hiringRecommendation: null, scores: {}, lastSavedAt: null });
    expect(await stored(t.applicationId)).toEqual([]); // reading writes nothing
  });
});

describe('final evaluation draft (S2.2): saving', () => {
  it('the first save creates the one shared draft, incomplete; the other evaluator reads and continues it', async () => {
    const t = await endedTraining();
    const [c1, c2] = [await criterion(t.admin.client), await criterion(t.admin.client)];

    const first = await save(t.mentor.client, t.applicationId, {
      comment: '  Steady progress  ',
      scores: { [c1.id]: 3 },
    });
    expect(first.status).toBe(200);
    const saved = await body<Detail>(first);
    expect([saved.status, saved.revision]).toEqual(['Draft', 1]);
    expect(saved.draft).toMatchObject({
      comment: 'Steady progress',
      hiringRecommendation: null,
      scores: { [c1.id]: 3 },
    });
    expect(saved.draft!.scores[c2.id]).toBeUndefined(); // never scored: absent
    const [row] = await stored(t.applicationId);
    expect(row).toMatchObject({
      status: 'Draft',
      version: 1,
      comment: 'Steady progress',
      assignment_id: t.assignmentId,
    });
    expect(saved.draft!.lastSavedAt).toBe(row!.updated_at.toISOString());

    // The responsible HR sees the same draft and saves on top of it; what it leaves out is kept.
    const shared = await read(t.hr.client, t.applicationId);
    expect([shared.revision, shared.draft]).toEqual([1, saved.draft]);
    const second = await save(t.hr.client, t.applicationId, {
      revision: 1,
      comment: null,
      hiringRecommendation: 'Yes',
      scores: { [c2.id]: 5 },
    });
    expect(second.status).toBe(200);
    const after = await body<Detail>(second);
    expect(after.revision).toBe(2);
    expect(after.draft).toMatchObject({
      comment: null,
      hiringRecommendation: 'Yes',
      scores: { [c1.id]: 3, [c2.id]: 5 },
    });
    expect(new Date(after.draft!.lastSavedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(saved.draft!.lastSavedAt!).getTime(),
    );
    expect((await read(t.mentor.client, t.applicationId)).draft).toEqual(after.draft);
  });

  it('a saved score changes to another whole number 1–5, but null never clears it', async () => {
    const t = await endedTraining();
    const c = await criterion(t.admin.client);
    expect((await save(t.mentor.client, t.applicationId, { scores: { [c.id]: 3 } })).status).toBe(200);

    expect((await save(t.mentor.client, t.applicationId, { revision: 1, scores: { [c.id]: 1 } })).status).toBe(200);
    const clearing = await save(t.mentor.client, t.applicationId, { revision: 2, scores: { [c.id]: null } });
    expect(clearing.status).toBe(400);
    expect(await problem(clearing)).toMatchObject({ code: 'validation.range' });

    const [row] = await stored(t.applicationId);
    expect([row!.version, row!.scores]).toEqual([2, { [c.id]: 1 }]);
  });

  it('refuses invalid input with 400 and writes nothing', async () => {
    const t = await endedTraining();
    const c = await criterion(t.admin.client);
    for (const [label, request] of [
      ['score 0', { ...empty, scores: { [c.id]: 0 } }],
      ['score 6', { ...empty, scores: { [c.id]: 6 } }],
      ['score 2.5', { ...empty, scores: { [c.id]: 2.5 } }],
      ['score "3"', { ...empty, scores: { [c.id]: '3' } }],
      ['score null', { ...empty, scores: { [c.id]: null } }],
      ['not a criterion id', { ...empty, scores: { punctuality: 3 } }],
      ['negative revision', { ...empty, revision: -1 }],
      ['comment too long', { ...empty, comment: 'ع'.repeat(4001) }],
      ['unknown recommendation', { ...empty, hiringRecommendation: 'Perhaps' }],
      ['an extra field (status)', { ...empty, status: 'Submitted' }],
      ['an extra field (mean)', { ...empty, mean: 4.5 }],
      ['no revision', { comment: null, hiringRecommendation: null, scores: {} }],
      ['no scores', { revision: 0, comment: null, hiringRecommendation: null }],
      ['no comment', { revision: 0, hiringRecommendation: null, scores: {} }],
    ] as const) {
      const response = await t.mentor.client.put(`/api/evaluations/${t.applicationId}/draft`, request);
      expect(response.status, label).toBe(400);
    }
    expect(await stored(t.applicationId)).toEqual([]);
  });

  it('accepts a comment of exactly 4,000 characters', async () => {
    const t = await endedTraining();
    const response = await save(t.mentor.client, t.applicationId, { comment: 'ع'.repeat(4000) });
    expect(response.status).toBe(200);
    expect((await body<Detail>(response)).draft!.comment).toHaveLength(4000);
  });
});

describe('final evaluation draft (S2.2): identifiers', () => {
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const millis = (id: string) => parseInt(id.replace(/-/g, '').slice(0, 12), 16);

  it('a new draft and its scores get UUID v7 ids, time-ordered from the save (docs/architecture.md)', async () => {
    const t = await endedTraining();
    const [c1, c2] = [await criterion(t.admin.client), await criterion(t.admin.client)];
    const before = api.clock.now().getTime();
    expect((await save(t.mentor.client, t.applicationId, { scores: { [c1.id]: 3, [c2.id]: 4 } })).status).toBe(200);
    const after = api.clock.now().getTime();
    const ids = await withDb((db) =>
      db.query<{ id: string; kind: string }>(
        `SELECT e.id::text, 'evaluation' AS kind FROM evaluations e WHERE e.application_id = $1
         UNION ALL
         SELECT s.id::text, 'score' FROM evaluation_scores s JOIN evaluations e ON e.id = s.evaluation_id
          WHERE e.application_id = $1`,
        [t.applicationId],
      ),
    ).then((r) => r.rows);
    expect(ids.map((r) => r.kind).sort()).toEqual(['evaluation', 'score', 'score']);
    for (const { id } of ids) {
      expect(id).toMatch(V7);
      expect(millis(id) >= before && millis(id) <= after).toBe(true);
    }
  });
});

describe('final evaluation draft (S2.2): concurrency (optimistic, atomic)', () => {
  it('a stale revision is refused with 409 conflict.concurrent_update and changes nothing', async () => {
    const t = await endedTraining();
    const c = await criterion(t.admin.client);
    expect((await save(t.mentor.client, t.applicationId, { scores: { [c.id]: 2 } })).status).toBe(200);
    const before = await stored(t.applicationId);

    const stale = await save(t.hr.client, t.applicationId, {
      revision: 0,
      comment: 'Overwrite?',
      scores: { [c.id]: 5 },
    });
    expect(stale.status).toBe(409);
    expect(await problem(stale)).toMatchObject({ code: 'conflict.concurrent_update' });
    expect(await stored(t.applicationId)).toEqual(before);
  });

  it('two simultaneous first saves create one draft: one wins, the other gets 409 and leaves no trace', async () => {
    const t = await endedTraining();
    const [c1, c2] = [await criterion(t.admin.client), await criterion(t.admin.client)];

    const [mentor, hr] = await Promise.all([
      save(t.mentor.client, t.applicationId, { comment: 'Mentor', scores: { [c1.id]: 2 } }),
      save(t.hr.client, t.applicationId, { comment: 'HR', scores: { [c1.id]: 4, [c2.id]: 5 } }),
    ]);
    expect([mentor.status, hr.status].sort()).toEqual([200, 409]);
    const [winner, loser] = mentor.status === 200 ? [mentor, hr] : [hr, mentor];
    expect((await problem(loser)).code).toBe('conflict.concurrent_update');

    const rows = await stored(t.applicationId);
    expect(rows).toHaveLength(1);
    const won = (await body<Detail>(winner)).draft!;
    expect([rows[0]!.version, rows[0]!.comment, rows[0]!.scores]).toEqual([1, won.comment, won.scores]);
  });

  it('the mentor and the HR saving the same revision at once: one 200, one 409, no lost update', async () => {
    const t = await endedTraining();
    const c = await criterion(t.admin.client);
    expect((await save(t.mentor.client, t.applicationId, { scores: { [c.id]: 3 } })).status).toBe(200);

    const [mentor, hr] = await Promise.all([
      save(t.mentor.client, t.applicationId, { revision: 1, comment: 'Mentor', scores: { [c.id]: 1 } }),
      save(t.hr.client, t.applicationId, { revision: 1, comment: 'HR', scores: { [c.id]: 5 } }),
    ]);
    expect([mentor.status, hr.status].sort()).toEqual([200, 409]);
    const won = (await body<Detail>(mentor.status === 200 ? mentor : hr)).draft!;
    const [row] = await stored(t.applicationId);
    expect([row!.version, row!.comment, row!.scores]).toEqual([2, won.comment, won.scores]);
  });
});

describe('final evaluation draft (S2.2): criteria', () => {
  it('an inactive criterion is hidden and keeps its score; saving it is refused; reactivating shows its score again', async () => {
    const t = await endedTraining();
    const [kept, other] = [await criterion(t.admin.client), await criterion(t.admin.client)];
    expect((await save(t.mentor.client, t.applicationId, { scores: { [kept.id]: 4 } })).status).toBe(200);

    await setActive(t.admin.client, kept, false);
    try {
      const hidden = await read(t.mentor.client, t.applicationId);
      expect(hidden.criteria.map((c) => c.id)).not.toContain(kept.id);
      expect(hidden.draft!.scores).toEqual({});

      // A form opened before the change: refused, nothing written.
      const stale = await save(t.mentor.client, t.applicationId, {
        revision: 1,
        scores: { [kept.id]: 2, [other.id]: 3 },
      });
      expect(stale.status).toBe(409);
      expect(await problem(stale)).toMatchObject({ code: 'evaluation.criteria_changed' });
      // Saving without it keeps its score in the database.
      expect((await save(t.mentor.client, t.applicationId, { revision: 1, scores: { [other.id]: 3 } })).status).toBe(
        200,
      );
      expect((await stored(t.applicationId))[0]!.scores).toEqual({ [kept.id]: 4, [other.id]: 3 });
    } finally {
      await setActive(t.admin.client, kept, true);
    }

    expect((await read(t.hr.client, t.applicationId)).draft!.scores).toEqual({ [kept.id]: 4, [other.id]: 3 });
  });

  it('a criterion that does not exist is refused like a changed one', async () => {
    const t = await endedTraining();
    const response = await save(t.mentor.client, t.applicationId, { scores: { [crypto.randomUUID()]: 3 } });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe('evaluation.criteria_changed');
    expect(await stored(t.applicationId)).toEqual([]);
  });
});

describe('final evaluation draft (S2.2): who may save', () => {
  it('Admin (even as final mentor) and trainee 403, signed out 401, others 404 like a missing training', async () => {
    const t = await endedTraining();
    const otherHr = await signInStaff(api, 'HR');
    const missing = await save(otherHr.client, crypto.randomUUID(), {});
    expect(missing.status).toBe(404);
    const notFound = await problem(missing);

    for (const client of [t.admin.client, t.trainee.client]) {
      expect((await save(client, t.applicationId, {})).status).toBe(403);
    }
    expect((await save(api.client(), t.applicationId, {})).status).toBe(401);
    for (const client of [otherHr.client, (await signInStaff(api, 'Employee')).client]) {
      const response = await save(client, t.applicationId, {});
      expect(response.status).toBe(404);
      expect(await problem(response)).toEqual(notFound);
    }
    await setRole(t.mentor.email, 'Admin');
    expect((await save(t.mentor.client, t.applicationId, {})).status).toBe(403);
    expect(await stored(t.applicationId)).toEqual([]);
  });

  it('a responsible HR who loses the role, or a replaced one, can no longer save; the replacement can', async () => {
    const t = await endedTraining();
    expect((await save(t.hr.client, t.applicationId, { comment: 'First' })).status).toBe(200);

    await setRole(t.hr.email, 'Employee');
    expect((await save(t.hr.client, t.applicationId, { revision: 1 })).status).toBe(404);
    await setRole(t.hr.email, 'HR');

    const replacement = await signInStaff(api, 'HR');
    const moved = await t.admin.client.put(`/api/admin/accepted-trainees/${t.applicationId}/responsible-hr`, {
      hrId: replacement.user.id,
    });
    expect(moved.status).toBe(200);
    expect((await save(t.hr.client, t.applicationId, { revision: 1 })).status).toBe(404);
    expect((await save(replacement.client, t.applicationId, { revision: 1, comment: 'Second' })).status).toBe(200);
  });

  it('a previous final mentor (transferred away) cannot save, even with the right revision; the new mentor and the HR can', async () => {
    // A training is transferred only while Active and has a draft only once ended (owner decision 2026-11-22): the
    // supported order is transfer, end, then draft. The save follows the latest mentor, checked at every save.
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const previous = await signInStaff(api, 'Employee');
    const next = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const c = await criterion(admin.client);
    const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id, 'Draft Trainee');
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    const first = await seedAssignment(
      applicationId,
      previous.user.id,
      addDays(today(), -30),
      addDays(today(), 30),
      'Active',
    );
    const transferred = await hr.client.post(`/api/hr/assignments/${first}/transfer`, {
      employeeId: next.user.id,
      transferDate: today(),
      reason: 'Synthetic transfer',
    });
    expect(transferred.status).toBe(200);
    const latest = await withDb((db) =>
      db.query<{ id: string; employee_id: string }>(
        "SELECT id, employee_id FROM assignments WHERE application_id = $1 AND status = 'Active'",
        [applicationId],
      ),
    );
    expect(latest.rows.map((r) => r.employee_id)).toEqual([next.user.id]);
    const ended = await hr.client.post(`/api/hr/assignments/${latest.rows[0]!.id}/complete`, {
      endDate: today(),
      reason: 'Synthetic early end',
    });
    expect(ended.status).toBe(200);

    expect(
      (
        await save(next.client, applicationId, {
          comment: 'By the new mentor',
          hiringRecommendation: 'Yes',
          scores: { [c.id]: 4 },
        })
      ).status,
    ).toBe(200);
    const before = await stored(applicationId);
    expect(before).toMatchObject([
      { version: 1, comment: 'By the new mentor', recommendation: 'Yes', scores: { [c.id]: 4 } },
    ]);

    // The previous mentor gets the same 404 as for a training that does not exist, and nothing changes.
    const notFound = await problem(await save(hr.client, crypto.randomUUID(), {}));
    expect((await previous.client.get(`/api/evaluations/${applicationId}`)).status).toBe(404);
    const refused = await save(previous.client, applicationId, {
      revision: 1,
      comment: 'By the previous mentor',
      hiringRecommendation: 'No',
      scores: { [c.id]: 1 },
    });
    expect(refused.status).toBe(404);
    expect(await problem(refused)).toEqual(notFound);
    expect(await stored(applicationId)).toEqual(before); // scores, comment, recommendation, revision, last-saved time

    // The current evaluators keep the draft.
    expect((await save(next.client, applicationId, { revision: 1, scores: { [c.id]: 5 } })).status).toBe(200);
    expect((await save(hr.client, applicationId, { revision: 2, comment: 'By the HR' })).status).toBe(200);
    expect(await stored(applicationId)).toMatchObject([{ version: 3, comment: 'By the HR', scores: { [c.id]: 5 } }]);
  });

  it('a training not ended (or withdrawn) cannot be saved: 409 for its evaluators', async () => {
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const mentor = await signInStaff(api, 'Employee');
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, (await newField(admin.client)).id);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    await seedAssignment(applicationId, mentor.user.id, addDays(today(), -30), addDays(today(), 30), 'Active');

    for (const client of [mentor.client, hr.client]) {
      const response = await save(client, applicationId, {});
      expect(response.status).toBe(409);
      expect((await problem(response)).code).toBe('evaluation.not_available');
    }
    expect(await stored(applicationId)).toEqual([]);
  });

  it('a submitted evaluation is read-only: 409 evaluation.already_submitted, nothing changes, no draft in GET', async () => {
    const t = await endedTraining();
    const c = await criterion(t.admin.client);
    expect((await save(t.mentor.client, t.applicationId, { comment: 'Text', scores: { [c.id]: 4 } })).status).toBe(200);
    // Submitted the S2.3 way by the database owner (no submission API in S2.2).
    await withDb((db) =>
      db.query(
        `UPDATE evaluation_scores SET frozen_name_ar = 'معيار', frozen_name_en = 'Frozen', frozen_sort_order = 1
          WHERE evaluation_id = (SELECT id FROM evaluations WHERE application_id = $1);
         UPDATE evaluations SET status = 'Submitted', hiring_recommendation = 'Yes', submitted_by_id = $2, submitted_at = now()
          WHERE application_id = $1`
          .replace(/\$1/g, `'${t.applicationId}'`)
          .replace(/\$2/g, `'${t.mentor.user.id}'`),
      ),
    );
    const before = await stored(t.applicationId);

    const response = await save(t.mentor.client, t.applicationId, {
      revision: 1,
      comment: 'Changed',
      scores: { [c.id]: 1 },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe('evaluation.already_submitted');
    expect(await stored(t.applicationId)).toEqual(before);
    const d = await read(t.hr.client, t.applicationId);
    expect(d.status).toBe('Submitted');
    expect('draft' in d || 'revision' in d).toBe(false);
  });
});

describe('final evaluation draft (S2.2): privacy', () => {
  it('shows only the last-saved time, never who saved; no mean, grade or audit number; events hidden from the Admin', async () => {
    const t = await endedTraining();
    const [c1, c2] = [await criterion(t.admin.client), await criterion(t.admin.client)];
    const saved = await save(t.hr.client, t.applicationId, {
      comment: 'PRIVATE-DRAFT-COMMENT',
      hiringRecommendation: 'No',
      scores: { [c1.id]: 2, [c2.id]: 4 },
    });
    expect(saved.status).toBe(200);

    const responses = [await body<Detail>(saved), await read(t.mentor.client, t.applicationId)];
    // The exact shape, level by level: every key is known, so no audit number (or any other identifier) can travel
    // under another name. Business numbers are checked by their key: orders, scores 1-5 by criterion id, the revision.
    for (const d of responses as unknown as Record<string, unknown>[]) {
      expect(Object.keys(d).sort()).toEqual([
        'applicationId',
        'capacities',
        'commentOnly',
        'criteria',
        'criteriaVersion',
        'draft',
        'endDate',
        'endStatus',
        'fieldName',
        'revision',
        'startDate',
        'status',
        'traineeName',
      ]);
      const draft = d.draft as Record<string, unknown>;
      expect(Object.keys(draft).sort()).toEqual(['comment', 'hiringRecommendation', 'lastSavedAt', 'scores']);
      expect(draft.scores).toEqual({ [c1.id]: 2, [c2.id]: 4 });
      expect(Number.isInteger(d.revision) && (d.revision as number) >= 1).toBe(true);
      expect(d.criteriaVersion).toMatch(/^c1\.[A-Za-z0-9_-]{43}$/); // a fingerprint of the criteria, not a number
      for (const c of d.criteria as Record<string, unknown>[]) {
        expect(Object.keys(c).sort()).toEqual(['id', 'nameAr', 'nameEn', 'sortOrder']);
        expect(Number.isInteger(c.sortOrder)).toBe(true);
      }
    }
    const keys: string[] = [];
    const texts: string[] = [];
    const walk = (node: unknown, inScores = false) => {
      if (Array.isArray(node)) node.forEach((n) => walk(n));
      else if (node && typeof node === 'object')
        for (const [key, value] of Object.entries(node)) {
          if (!inScores) keys.push(key);
          walk(value, key === 'scores');
        }
      else if (typeof node === 'string') texts.push(node);
    };
    responses.forEach((r) => walk(r));
    expect(
      keys.filter(
        (k) =>
          /mean|average|avg|total|sum|grade|savedBy|updatedBy|employee|submitted|email|phone|audit|^id$/i.test(k) &&
          k !== 'id',
      ),
    ).toEqual([]);
    expect(texts).not.toContain(t.hr.user.id);
    // This test's own evaluation audit rows (other files write theirs concurrently): none of their numbers is in any
    // text value or identifier of the responses.
    const ownAudit = await withDb((db) =>
      db.query<{ id: string }>(
        `SELECT a.id::text FROM audit_logs a JOIN evaluations e ON e.application_id = $1
          WHERE (a.table_name = 'evaluations' AND a.entity_id = e.id::text)
             OR (a.table_name = 'evaluation_scores' AND a.new_values ->> 'evaluation_id' = e.id::text)`,
        [t.applicationId],
      ),
    ).then((r) => r.rows.map((row) => row.id));
    expect(ownAudit.length).toBeGreaterThanOrEqual(4); // the draft's insert and update, and its two scores
    for (const n of ownAudit) expect(texts).not.toContain(n);

    // The saves are audited internally, as the HR user, and the Admin's viewer shows none of them.
    const audited = await withDb((db) =>
      db.query<{ table_name: string; actor_id: string }>(
        `SELECT DISTINCT table_name, actor_id::text FROM audit_logs
          WHERE table_name IN ('evaluations', 'evaluation_scores') AND actor_id = $1 ORDER BY 1`,
        [t.hr.user.id],
      ),
    );
    expect(audited.rows.map((r) => r.table_name)).toEqual(['evaluation_scores', 'evaluations']);
    const viewer = await body<{ entries: { table: string }[] }>(
      await t.admin.client.get(`/api/admin/audit-logs?actorId=${t.hr.user.id}`),
    );
    expect(viewer.entries.filter((e) => e.table.startsWith('evaluation') && e.table !== 'evaluation_criteria')).toEqual(
      [],
    );
  });

  it('an unchanged score is not rewritten (no audit row for it)', async () => {
    const t = await endedTraining();
    const c = await criterion(t.admin.client);
    expect((await save(t.mentor.client, t.applicationId, { scores: { [c.id]: 3 } })).status).toBe(200);
    const count = () =>
      withDb((db) =>
        db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM audit_logs WHERE table_name = 'evaluation_scores' AND new_values ->> 'criterion_id' = $1",
          [c.id],
        ),
      ).then((r) => r.rows[0]!.n);
    const before = await count();
    expect((await save(t.mentor.client, t.applicationId, { revision: 1, scores: { [c.id]: 3 } })).status).toBe(200);
    expect(await count()).toBe(before);
  });
});
