import { describe, expect, it } from 'vitest';
import { calendarDate } from '../src/domain/training';
import { body, createTestApi, setRole, signInStaff, signInTrainee, type TestClient, withDb } from './helpers';
import { newField, seedAssignment, submitApplication } from './seed';

/**
 * Final evaluation, stage S2.1 (R27; AD-66, AD-68 G2/G4/G8; owner decisions of 2026-11-22): the read-only list and
 * detail. Only the training's final mentor (holding the Employee or HR role now) and its current responsible HR (holding
 * the HR role now) see it, checked on every request; the Admin never (403, even as the final mentor), nor the trainee
 * (403); anyone else gets the same 404 as for an evaluation that does not exist; before HR ends the training as
 * Completed or EndedEarly (or after Withdrawn) an evaluator gets 409. Nothing about scores, comments, recommendations
 * or any average is returned. Real HR and Admin endpoints; evaluation rows are seeded by the database owner (the Worker
 * cannot write them in S2.1).
 */
const api = createTestApi();

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => calendarDate(new Date());

interface ListItem {
  applicationId: string;
  traineeName: string | null;
  fieldName: string;
  endStatus: string;
  endDate: string;
  capacities: string[];
  status: string;
}
interface Detail extends ListItem {
  startDate: string;
  commentOnly: boolean;
  criteria: { id: string; nameAr: string; nameEn: string; sortOrder: number }[];
}

const LIST_KEYS = ['applicationId', 'capacities', 'endDate', 'endStatus', 'fieldName', 'status', 'traineeName'];
// S2.2 (AD-70): while not submitted, the detail also carries the shared draft (revision and draft values); S2.3 (AD-71)
// the fingerprint of the active criteria shown.
const DETAIL_KEYS = [
  ...LIST_KEYS,
  'commentOnly',
  'criteria',
  'criteriaVersion',
  'draft',
  'revision',
  'startDate',
].sort();

const list = async (client: TestClient) => {
  const response = await client.get('/api/evaluations');
  expect(response.status).toBe(200);
  return body<ListItem[]>(response);
};
const listed = async (client: TestClient, applicationId: string) =>
  (await list(client)).find((i) => i.applicationId === applicationId);
const detail = (client: TestClient, applicationId: string) => client.get(`/api/evaluations/${applicationId}`);
const problem = async (response: Response) => {
  const { traceId: _traceId, ...rest } = await body<Record<string, unknown>>(response);
  return rest;
};

/** An accepted training (responsible HR = the accepting HR), Active with `mentor` from 30 days ago to `plannedEnd`. */
async function training(plannedEnd = addDays(today(), 30)) {
  const admin = await signInStaff(api, 'Admin');
  const hr = await signInStaff(api, 'HR');
  const mentor = await signInStaff(api, 'Employee');
  const trainee = await signInTrainee(api);
  const field = await newField(admin.client);
  const applicationId = await submitApplication(trainee.client, field.id, 'Synthetic Evaluated Trainee');
  expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
  const assignmentId = await seedAssignment(applicationId, mentor.user.id, addDays(today(), -30), plannedEnd, 'Active');
  return { admin, hr, mentor, trainee, field, applicationId, assignmentId };
}

/** HR ends an assignment: Completed on its planned end date, EndedEarly (with a reason) before it. */
async function end(hr: TestClient, assignmentId: string, early = true) {
  const response = await hr.post(
    `/api/hr/assignments/${assignmentId}/complete`,
    early ? { endDate: today(), reason: 'Synthetic early end' } : { endDate: today() },
  );
  expect(response.status).toBe(200);
}

async function endedTraining(early = true) {
  const t = await training(early ? addDays(today(), 30) : today());
  await end(t.hr.client, t.assignmentId, early);
  return t;
}

/** A final evaluation row as a later stage will write it (seeded as the database owner, actor System). */
async function seedEvaluation(
  applicationId: string,
  assignmentId: string,
  values: {
    status: 'Draft' | 'Submitted';
    submittedBy?: string;
    frozen?: { criterion: string; score: number; order: number }[];
  },
) {
  const id = crypto.randomUUID();
  await withDb(async (db) => {
    await db.query('BEGIN');
    await db.query("SELECT set_config('ims.actor_type', 'System', true)");
    await db.query(
      `INSERT INTO evaluations (id, application_id, assignment_id, status, comment, hiring_recommendation, version,
                                created_at, updated_at, submitted_by_id, submitted_at)
       VALUES ($1, $2, $3, 'Draft', 'SECRET-EVALUATION-COMMENT', 'Maybe', 7, now(), now(), NULL, NULL)`,
      [id, applicationId, assignmentId],
    );
    for (const f of values.frozen ?? []) {
      await db.query(
        `INSERT INTO evaluation_scores (id, evaluation_id, criterion_id, score, frozen_name_ar, frozen_name_en, frozen_sort_order)
         VALUES (gen_random_uuid(), $1, $2, $3, 'اسم مجمد', 'Frozen name', $4)`,
        [id, f.criterion, f.score, f.order],
      );
    }
    // S2.3's order (the database guards refuse score writes once submitted): freeze the scores, then submit.
    if (values.status === 'Submitted') {
      await db.query(
        "UPDATE evaluations SET status = 'Submitted', submitted_by_id = $2, submitted_at = now() WHERE id = $1",
        [id, values.submittedBy],
      );
    }
    await db.query('COMMIT');
  });
  return id;
}

const activeCriteria = () =>
  withDb((db) =>
    db.query<{ id: string; nameAr: string; nameEn: string; sortOrder: number }>(
      'SELECT id, name_ar AS "nameAr", name_en AS "nameEn", sort_order AS "sortOrder" FROM evaluation_criteria WHERE is_active ORDER BY sort_order',
    ),
  ).then((r) => r.rows);

describe('final evaluation (S2.1): who sees it', () => {
  it('the final mentor and the current responsible HR see the ended training, each in their capacity', async () => {
    const admin = await signInStaff(api, 'Admin');
    await admin.client.post('/api/admin/evaluation-criteria', {
      nameAr: 'معيار تجريبي',
      nameEn: `Synthetic ${crypto.randomUUID()}`,
    });
    const t = await endedTraining();

    for (const [client, capacities] of [
      [t.mentor.client, ['FinalMentor']],
      [t.hr.client, ['ResponsibleHr']],
    ] as const) {
      const item = await listed(client, t.applicationId);
      expect(item).toEqual({
        applicationId: t.applicationId,
        traineeName: 'Synthetic Evaluated Trainee',
        fieldName: t.field.name,
        endStatus: 'EndedEarly',
        endDate: today(),
        capacities,
        status: 'NotStarted',
      });
      expect(Object.keys(item!).sort()).toEqual(LIST_KEYS);

      const response = await detail(client, t.applicationId);
      expect(response.status).toBe(200);
      const d = await body<Detail>(response);
      expect(Object.keys(d).sort()).toEqual(DETAIL_KEYS);
      expect(d).toMatchObject({ ...item, startDate: addDays(today(), -30), commentOnly: false });
      // The active criteria, in their order, with both names (AD-66, G7); inactive ones are left out.
      expect(d.criteria).toEqual(await activeCriteria());
      for (const c of d.criteria) expect(Object.keys(c).sort()).toEqual(['id', 'nameAr', 'nameEn', 'sortOrder']);
    }
  });

  it('a training completed on its planned end date is listed as Completed', async () => {
    const t = await endedTraining(false);
    expect((await listed(t.mentor.client, t.applicationId))?.endStatus).toBe('Completed');
  });

  it('a final mentor who holds the HR role now still sees it; one who is both evaluators has both capacities', async () => {
    const t = await endedTraining();
    await setRole(t.mentor.email, 'HR');
    expect((await listed(t.mentor.client, t.applicationId))?.capacities).toEqual(['FinalMentor']);
    expect((await detail(t.mentor.client, t.applicationId)).status).toBe(200);

    // The responsible HR mentored the training themselves.
    const hr = await signInStaff(api, 'HR');
    const trainee = await signInTrainee(api);
    const applicationId = await submitApplication(trainee.client, (await newField(t.admin.client)).id);
    expect((await hr.client.post(`/api/hr/applications/${applicationId}/accept`)).status).toBe(200);
    const assignment = await seedAssignment(
      applicationId,
      hr.user.id,
      addDays(today(), -30),
      addDays(today(), 30),
      'Active',
    );
    await end(hr.client, assignment);
    expect((await listed(hr.client, applicationId))?.capacities).toEqual(['FinalMentor', 'ResponsibleHr']);
  });

  it('the Admin is refused (403), even as the final mentor, and so is the trainee; signed out is 401', async () => {
    const t = await endedTraining();
    await setRole(t.mentor.email, 'Admin');
    for (const client of [t.mentor.client, t.admin.client, t.trainee.client]) {
      expect((await client.get('/api/evaluations')).status).toBe(403);
      expect((await detail(client, t.applicationId)).status).toBe(403);
    }
    expect((await api.client().get('/api/evaluations')).status).toBe(401);
    expect((await detail(api.client(), t.applicationId)).status).toBe(401);
  });

  it('anyone else gets the same 404 as for an evaluation that does not exist, and an empty list', async () => {
    const t = await endedTraining();
    const otherHr = await signInStaff(api, 'HR');
    const otherEmployee = await signInStaff(api, 'Employee');
    const missing = await detail(otherHr.client, crypto.randomUUID());
    expect(missing.status).toBe(404);
    const notFound = await problem(missing);

    for (const client of [otherHr.client, otherEmployee.client]) {
      const response = await detail(client, t.applicationId);
      expect(response.status).toBe(404);
      expect(await problem(response)).toEqual(notFound);
      expect(await listed(client, t.applicationId)).toBeUndefined();
    }
    expect(JSON.stringify(notFound)).not.toContain(t.applicationId);
  });
});

describe('final evaluation (S2.1): access follows the evaluators at every request', () => {
  it('a previous mentor loses it after a transfer; the latest mentor has it', async () => {
    const t = await training();
    const next = await signInStaff(api, 'Employee');
    const transferred = await t.hr.client.post(`/api/hr/assignments/${t.assignmentId}/transfer`, {
      employeeId: next.user.id,
      transferDate: today(),
      reason: 'Synthetic transfer',
    });
    expect(transferred.status).toBe(200);
    const latest = await withDb((db) =>
      db.query<{ id: string }>("SELECT id FROM assignments WHERE application_id = $1 AND status = 'Active'", [
        t.applicationId,
      ]),
    );
    await end(t.hr.client, latest.rows[0]!.id);

    expect((await detail(t.mentor.client, t.applicationId)).status).toBe(404);
    expect(await listed(t.mentor.client, t.applicationId)).toBeUndefined();
    expect((await listed(next.client, t.applicationId))?.capacities).toEqual(['FinalMentor']);
  });

  it('an Admin replacement of the responsible HR moves it at once', async () => {
    const t = await endedTraining();
    const replacement = await signInStaff(api, 'HR');
    expect(
      (
        await t.admin.client.put(`/api/admin/accepted-trainees/${t.applicationId}/responsible-hr`, {
          hrId: replacement.user.id,
        })
      ).status,
    ).toBe(200);

    expect((await detail(t.hr.client, t.applicationId)).status).toBe(404);
    expect((await listed(replacement.client, t.applicationId))?.capacities).toEqual(['ResponsibleHr']);
    // The final mentor keeps it.
    expect((await detail(t.mentor.client, t.applicationId)).status).toBe(200);
  });

  it('a responsible HR who loses the HR role loses it at once, and gets it back with the role', async () => {
    const t = await endedTraining();
    await setRole(t.hr.email, 'Employee');
    expect((await detail(t.hr.client, t.applicationId)).status).toBe(404);
    expect(await listed(t.hr.client, t.applicationId)).toBeUndefined();
    await setRole(t.hr.email, 'HR');
    expect((await detail(t.hr.client, t.applicationId)).status).toBe(200);
  });
});

describe('final evaluation (S2.1): only after HR ends the training', () => {
  it('an Active training, a Withdrawn one, or one never assigned: 409 for its evaluators, 404 for others, never listed', async () => {
    const active = await training();
    const withdrawn = await training();
    expect(
      (
        await withdrawn.hr.client.post(`/api/hr/assignments/${withdrawn.assignmentId}/withdraw`, {
          endDate: today(),
          reason: 'Synthetic withdrawal',
        })
      ).status,
    ).toBe(200);
    const otherHr = await signInStaff(api, 'HR');

    for (const t of [active, withdrawn]) {
      for (const client of [t.mentor.client, t.hr.client]) {
        const response = await detail(client, t.applicationId);
        expect(response.status).toBe(409);
        expect(await problem(response)).toMatchObject({ status: 409, code: 'evaluation.not_available' });
        expect(await listed(client, t.applicationId)).toBeUndefined();
      }
      expect((await detail(otherHr.client, t.applicationId)).status).toBe(404);
    }

    // Accepted, never assigned: its responsible HR is an evaluator-to-be.
    const admin = await signInStaff(api, 'Admin');
    const hr = await signInStaff(api, 'HR');
    const trainee = await signInTrainee(api);
    const unassigned = await submitApplication(trainee.client, (await newField(admin.client)).id);
    expect((await hr.client.post(`/api/hr/applications/${unassigned}/accept`)).status).toBe(200);
    expect((await detail(hr.client, unassigned)).status).toBe(409);
    expect((await detail(otherHr.client, unassigned)).status).toBe(404);
  });
});

describe('final evaluation (S2.1): what is returned', () => {
  it('shows the status of a draft, never its comment, recommendation, scores or any average', async () => {
    const t = await endedTraining();
    await seedEvaluation(t.applicationId, t.assignmentId, { status: 'Draft' });

    expect((await listed(t.mentor.client, t.applicationId))?.status).toBe('Draft');
    const d = await body<Detail>(await detail(t.hr.client, t.applicationId));
    expect(d.status).toBe('Draft');
    expect(d.criteria).toEqual(await activeCriteria());
  });

  it('a submitted evaluation shows its frozen criteria, not today’s; with none it is comment-only', async () => {
    const t = await endedTraining();
    const criterion = (await activeCriteria())[0] ?? null;
    const admin = await signInStaff(api, 'Admin');
    const created = criterion
      ? criterion
      : await body<{ id: string }>(
          await admin.client.post('/api/admin/evaluation-criteria', {
            nameAr: 'معيار',
            nameEn: `Synthetic ${crypto.randomUUID()}`,
          }),
        );
    await seedEvaluation(t.applicationId, t.assignmentId, {
      status: 'Submitted',
      submittedBy: t.mentor.user.id,
      frozen: [{ criterion: created.id, score: 5, order: 42 }],
    });
    const d = await body<Detail>(await detail(t.mentor.client, t.applicationId));
    expect([d.status, d.commentOnly]).toEqual(['Submitted', false]);
    expect(d.criteria).toEqual([{ id: created.id, nameAr: 'اسم مجمد', nameEn: 'Frozen name', sortOrder: 42 }]);

    const commentOnly = await endedTraining();
    await seedEvaluation(commentOnly.applicationId, commentOnly.assignmentId, {
      status: 'Submitted',
      submittedBy: commentOnly.hr.user.id,
    });
    const c = await body<Detail>(await detail(commentOnly.hr.client, commentOnly.applicationId));
    expect([c.status, c.commentOnly, c.criteria]).toEqual(['Submitted', true, []]);
    expect((await listed(commentOnly.hr.client, commentOnly.applicationId))?.status).toBe('Submitted');
  });

  it('a submitted evaluation: its evaluators get exactly the approved details, others nothing; never a mean, a version or the trainee’s contact data (G8, AD-71)', async () => {
    const t = await endedTraining();
    const criteria = await activeCriteria();
    await seedEvaluation(t.applicationId, t.assignmentId, {
      status: 'Submitted',
      submittedBy: t.mentor.user.id,
      frozen: criteria.slice(0, 2).map((c, i) => ({ criterion: c.id, score: 3 + i, order: c.sortOrder })),
    });
    const trainee = await withDb((db) =>
      db.query<{ email: string; phone: string }>(
        'SELECT t.email, t.phone FROM trainees t JOIN training_applications a ON a.trainee_id = t.id WHERE a.id = $1',
        [t.applicationId],
      ),
    ).then((r) => r.rows[0]!);
    const mentorName = await withDb((db) =>
      db.query<{ full_name: string }>('SELECT full_name FROM employees WHERE id = $1', [t.mentor.user.id]),
    ).then((r) => r.rows[0]!.full_name);

    const lists = [
      await body<Record<string, unknown>[]>(await t.mentor.client.get('/api/evaluations')),
      await body<Record<string, unknown>[]>(await t.hr.client.get('/api/evaluations')),
    ];
    for (const list of lists) {
      const item = list.find((i) => i.applicationId === t.applicationId)!;
      expect(Object.keys(item).sort()).toEqual(LIST_KEYS); // never a grade in a list (AD-71 decision 2)
    }
    const details = [
      await body<Record<string, unknown>>(await detail(t.mentor.client, t.applicationId)),
      await body<Record<string, unknown>>(await detail(t.hr.client, t.applicationId)),
    ];
    for (const d of details) {
      expect(Object.keys(d).sort()).toEqual(
        [...LIST_KEYS, 'commentOnly', 'criteria', 'startDate', 'submission'].sort(),
      );
      const submission = d.submission as Record<string, unknown>;
      expect(Object.keys(submission).sort()).toEqual([
        'comment',
        'grade',
        'hiringRecommendation',
        'scores',
        'submittedAt',
        'submittedBy',
      ]);
      expect(submission).toMatchObject({
        comment: 'SECRET-EVALUATION-COMMENT',
        hiringRecommendation: 'Maybe',
        scores: { [criteria[0]!.id]: 3, [criteria[1]!.id]: 4 },
        grade: 'Good', // (3 + 4) / 2 = 3.5, never shown as a number
        submittedBy: { name: mentorName },
      });
      expect(Object.keys(submission.submittedBy as object)).toEqual(['name']);
      expect(new Date(submission.submittedAt as string).toISOString()).toBe(submission.submittedAt);
    }
    const keys: string[] = [];
    const walk = (node: unknown, inScores = false) => {
      if (Array.isArray(node)) node.forEach((n) => walk(n));
      else if (node && typeof node === 'object')
        for (const [key, value] of Object.entries(node)) {
          if (!inScores) keys.push(key);
          walk(value, key === 'scores');
        }
    };
    [...lists, ...details].forEach((r) => walk(r));
    expect(
      keys.filter((k) => /mean|average|avg|total|sum|count|version|revision|draft|email|phone|audit/i.test(k)),
    ).toEqual([]);
    const text = JSON.stringify([...lists, ...details]);
    for (const secret of [trainee.email, trainee.phone]) expect(text).not.toContain(secret);

    // Not an evaluator: the same 404 as a missing training, nothing of the evaluation.
    const other = await signInStaff(api, 'HR');
    const refused = await detail(other.client, t.applicationId);
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toMatch(/SECRET-EVALUATION-COMMENT|Maybe|grade/);
  });

  it('reads only: nothing is written when evaluations are listed or opened', async () => {
    const t = await endedTraining();
    const fingerprint = () =>
      withDb((db) => db.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_logs')).then((r) =>
        Number(r.rows[0]!.n),
      );
    const evaluations = () =>
      withDb((db) =>
        db.query<{ n: number }>('SELECT count(*)::int AS n FROM evaluations WHERE application_id = $1', [
          t.applicationId,
        ]),
      ).then((r) => r.rows[0]!.n);
    const writesBy = () =>
      withDb((db) =>
        db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = ANY($1::uuid[])', [
          [t.mentor.user.id, t.hr.user.id],
        ]),
      ).then((r) => r.rows[0]!.n);
    expect(await fingerprint()).toBeGreaterThan(0);
    const before = await writesBy();

    await list(t.mentor.client);
    await detail(t.mentor.client, t.applicationId);
    await list(t.hr.client);
    await detail(t.hr.client, t.applicationId);

    expect(await writesBy()).toBe(before);
    expect(await evaluations()).toBe(0);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await t.mentor.client.request(method, `/api/evaluations/${t.applicationId}`, {})).status, method).toBe(
        405,
      );
    }
  });
});
