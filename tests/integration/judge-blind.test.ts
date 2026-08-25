import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview } from '@/lib/core/requests';
import { runOneJudge } from '@/lib/judge/run';
import { readFindings, untriagedFindings } from '@/lib/findings/read';
import { ship } from '@/lib/core/verdict';
import { setCriterionVerdict } from '@/lib/core/annotations';
import { judgeRuns, reviewRequests } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { JudgeScorer } from '@/lib/judge/scorer';

const BODY = `Subject: hello

Hi Dana, we sincerely apologize for the interruption.`;

const fakeScorer: JudgeScorer = async ({ criteria }) =>
  criteria.map((c) => ({
    criterionKey: c.key,
    score: c.key === 'voice' ? 0 : 1,
    passed: c.key !== 'voice',
    quote: c.key === 'voice' ? 'we sincerely apologize for the interruption.' : null,
    note: 'Apology opener.',
  }));

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({
    judgeEnabled: true,
    judgeSamplingPct: 100,
    judgeBlindSamplingPct: 100,
    piiDetection: false,
  });
});

describe('VOBO-176 / VOBO-199 judge-blind', () => {
  it('stamps blindness at creation and still runs the judge', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/b/acme/dana/seq1',
      title: 'Dana',
      contentMd: BODY,
    });
    const stored = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, request.id),
    });
    expect(stored?.judgeBlind).toBe(true);

    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    expect(run?.state).toBe('pending');
    await runOneJudge(db, run!.id, {
      scorer: fakeScorer,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });

    const reviewer = await readFindings(db, {
      requestId: request.id,
      versionId: run!.versionId,
      audience: 'reviewer',
    });
    expect(reviewer.withheld).toBe(true);
    expect(reviewer.findings).toEqual([]);
    expect(reviewer.run).toBeNull();
  });

  it('does not fire the untriaged-finding verdict gate on a blind request', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/b/acme/dana/seq2',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    await runOneJudge(db, run!.id, {
      scorer: fakeScorer,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    const pending = await untriagedFindings(db, request.id, run!.versionId);
    expect(pending).toEqual([]);

    for (const criterionId of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    const decision = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
    });
    expect(decision.status).toBe('accepted');

    const after = await readFindings(db, {
      requestId: request.id,
      versionId: run!.versionId,
      audience: 'reviewer',
    });
    expect(after.withheld).toBe(true);
    expect(after.findings).toEqual([]);
  });
});
