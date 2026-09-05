import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview, ApiProblem } from '@/lib/core/requests';
import { approveGate } from '@/lib/core/verdict';
import { claim } from '@/lib/core/queue';
import { runOneJudge } from '@/lib/judge/run';
import { rerunJudge } from '@/lib/judge/rerun';
import { readFindings } from '@/lib/findings/read';
import { getVerifiedChain } from '@/lib/core/eventlog';
import {
  artifactVersions,
  judgeRecords,
  judgeRuns,
  machineFindings,
  reviewRequests,
} from '@/lib/db/schema';
import type { JudgeScorer } from '@/lib/judge/scorer';

const BODY = `Subject: hello

Hi Dana, we sincerely apologize for the interruption.

Reach us at dana@acme.test please.`;

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({
    judgeEnabled: true,
    judgeSamplingPct: 100,
    judgeBlindSamplingPct: 0,
    piiDetection: true,
  });
});

const failVoice: JudgeScorer = async ({ criteria }) =>
  criteria.map((c) => ({
    criterionKey: c.key,
    score: c.key === 'voice' ? 0 : 1,
    passed: c.key !== 'voice',
    quote: c.key === 'voice' ? 'we sincerely apologize for the interruption.' : null,
    note: c.key === 'voice' ? 'Apology opener.' : 'ok',
  }));

const passAll: JudgeScorer = async ({ criteria }) =>
  criteria.map((c) => ({
    criterionKey: c.key,
    score: 1,
    passed: true,
    quote: null,
    note: 'ok',
  }));

async function createPending() {
  const { request } = await createReview(db, {
    projectId: fx.projectId,
    queueSlug: 'q',
    customerRequestId: 'pico/rerun/' + Math.random().toString(16).slice(2),
    title: 'Dana',
    contentMd: BODY,
  });
  const version = await db.query.artifactVersions.findFirst({
    where: eq(artifactVersions.requestId, request.id),
  });
  const run = await db.query.judgeRuns.findFirst({
    where: eq(judgeRuns.versionId, version!.id),
  });
  return { request, version: version!, run: run! };
}

describe('VOBO-298: rerun judge on the current artifact', () => {
  it('resets a completed run to pending without a new version', async () => {
    const { request, version, run } = await createPending();
    await runOneJudge(db, run.id, {
      scorer: failVoice,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    const versionsBefore = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));

    const res = await rerunJudge(db, {
      requestId: request.id,
      versionId: version.id,
      userId: fx.userId,
    });
    expect(res.runId).toBe(run.id);

    const after = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, run.id) });
    expect(after?.state).toBe('pending');
    expect(after?.attempts).toBe(0);
    expect(after?.completedAt).toBeNull();
    expect(after?.overallScore).toBeNull();

    const versionsAfter = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    expect(versionsAfter).toHaveLength(versionsBefore.length);

    const runs = await db.select().from(judgeRuns).where(eq(judgeRuns.requestId, request.id));
    expect(runs).toHaveLength(1);

    const { rows } = await getVerifiedChain(db, request.id);
    expect(rows.map((r) => r.type)).toContain('judge.rerun_requested');
  });

  it('worker produces new findings; previous judge findings are not live', async () => {
    const { request, version, run } = await createPending();
    await runOneJudge(db, run.id, {
      scorer: failVoice,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    const first = await readFindings(db, {
      requestId: request.id,
      versionId: version.id,
      audience: 'reviewer',
    });
    const firstJudge = first.findings.filter((f) => f.criterionKey !== 'pii');
    expect(firstJudge.some((f) => f.criterionKey === 'voice' && f.passed === false)).toBe(true);
    const piiBefore = first.findings.filter((f) => f.criterionKey === 'pii');
    expect(piiBefore.length).toBeGreaterThan(0);

    await rerunJudge(db, {
      requestId: request.id,
      versionId: version.id,
      userId: fx.userId,
    });
    const mid = await readFindings(db, {
      requestId: request.id,
      versionId: version.id,
      audience: 'reviewer',
    });
    expect(mid.findings.filter((f) => f.criterionKey !== 'pii')).toHaveLength(0);
    expect(mid.findings.filter((f) => f.criterionKey === 'pii').length).toBe(piiBefore.length);

    const result = await runOneJudge(db, run.id, {
      scorer: passAll,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(result).toBe('completed');

    const second = await readFindings(db, {
      requestId: request.id,
      versionId: version.id,
      audience: 'reviewer',
    });
    const secondJudge = second.findings.filter((f) => f.criterionKey !== 'pii');
    expect(secondJudge.length).toBeGreaterThan(0);
    expect(secondJudge.every((f) => f.passed === true)).toBe(true);
    expect(secondJudge.some((f) => firstJudge.some((old) => old.id === f.id))).toBe(false);

    const purged = await db
      .select()
      .from(machineFindings)
      .where(eq(machineFindings.versionId, version.id));
    expect(purged.filter((f) => f.criterionKey !== 'pii' && f.purgedAt).length).toBeGreaterThan(0);

    const records = await db
      .select()
      .from(judgeRecords)
      .where(eq(judgeRecords.versionId, version.id));
    expect(records.length).toBe(2);

    const { rows } = await getVerifiedChain(db, request.id);
    const types = rows.map((r) => r.type);
    expect(types.filter((t) => t === 'judge.completed').length).toBe(2);
  });

  it('forces a not_sampled run to pending', async () => {
    const offSample = await createFixtures({
      judgeEnabled: true,
      judgeSamplingPct: 0,
      judgeBlindSamplingPct: 0,
    });
    const { request } = await createReview(db, {
      projectId: offSample.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/rerun/ns',
      title: 'Dana',
      contentMd: BODY,
    });
    const version = await db.query.artifactVersions.findFirst({
      where: eq(artifactVersions.requestId, request.id),
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.versionId, version!.id),
    });
    expect(run?.state).toBe('not_sampled');

    await rerunJudge(db, {
      requestId: request.id,
      versionId: version!.id,
      userId: offSample.userId,
    });
    const after = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, run!.id) });
    expect(after?.state).toBe('pending');

    const result = await runOneJudge(db, run!.id, {
      scorer: passAll,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(result).toBe('completed');
  });

  it('purged judge findings do not satisfy the criteria gate', async () => {
    const { request, version, run } = await createPending();
    await runOneJudge(db, run.id, {
      scorer: failVoice,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    await claim(db, request.id, fx.userId);
    const before = await approveGate(db, request.id, fx.userId);
    expect(before.reasons.some((r) => r.startsWith('Score all criteria'))).toBe(false);

    await rerunJudge(db, {
      requestId: request.id,
      versionId: version.id,
      userId: fx.userId,
    });
    const after = await approveGate(db, request.id, fx.userId);
    expect(after.blocked).toBe(true);
    expect(after.reasons.some((r) => r.startsWith('Score all criteria'))).toBe(true);
  });

  it('refuses accepted with 409 and leaves the run', async () => {
    const { request, version, run } = await createPending();
    await runOneJudge(db, run.id, {
      scorer: passAll,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    await db
      .update(reviewRequests)
      .set({ status: 'accepted' })
      .where(eq(reviewRequests.id, request.id));

    await expect(
      rerunJudge(db, { requestId: request.id, versionId: version.id, userId: fx.userId })
    ).rejects.toMatchObject({ status: 409, code: 'already_accepted' });

    const after = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, run.id) });
    expect(after?.state).toBe('completed');
  });

  it('refuses running with 409', async () => {
    const { request, version, run } = await createPending();
    await db.update(judgeRuns).set({ state: 'running' }).where(eq(judgeRuns.id, run.id));

    await expect(
      rerunJudge(db, { requestId: request.id, versionId: version.id, userId: fx.userId })
    ).rejects.toMatchObject({ status: 409, code: 'judge_running' });

    const after = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, run.id) });
    expect(after?.state).toBe('running');
  });

  it('sequential runOneJudge still completes then skips', async () => {
    const { run } = await createPending();
    const first = await runOneJudge(db, run.id, {
      scorer: passAll,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(first).toBe('completed');
    const second = await runOneJudge(db, run.id, {
      scorer: passAll,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(second).toBe('skipped');
  });

  it('skips when the run is already claimed', async () => {
    const { run } = await createPending();
    await db.update(judgeRuns).set({ state: 'running' }).where(eq(judgeRuns.id, run.id));
    const result = await runOneJudge(db, run.id, {
      scorer: passAll,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(result).toBe('skipped');
    const after = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, run.id) });
    expect(after?.state).toBe('running');
  });

  it('does not change judge_blind', async () => {
    const { request, version, run } = await createPending();
    await db
      .update(reviewRequests)
      .set({ judgeBlind: true })
      .where(eq(reviewRequests.id, request.id));
    await runOneJudge(db, run.id, {
      scorer: failVoice,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });

    await rerunJudge(db, {
      requestId: request.id,
      versionId: version.id,
      userId: fx.userId,
    });
    const stored = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, request.id),
    });
    expect(stored?.judgeBlind).toBe(true);
  });
});
