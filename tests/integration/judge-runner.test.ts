import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview } from '@/lib/core/requests';
import { runOneJudge } from '@/lib/judge/run';
import { judgeRuns, machineFindings, reviewRequests, artifactVersions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { JudgeScorer } from '@/lib/judge/scorer';
import { detectPii } from '@/lib/judge/pii';
import { isSampled } from '@/lib/judge/sampling';
import { locateQuote } from '@/lib/findings/fingerprint';
import { readFileSync } from 'fs';

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

const fakeScorer: JudgeScorer = async ({ contentMd, criteria }) =>
  criteria.map((c) => ({
    criterionKey: c.key,
    score: c.key === 'voice' ? 0 : 1,
    passed: c.key !== 'voice',
    quote: c.key === 'voice' ? 'we sincerely apologize for the interruption.' : null,
    note: c.key === 'voice' ? 'Apology opener.' : 'ok',
  }));

describe('VOBO-51 judge runner', () => {
  it('enqueues a pending run on create when the judge is enabled', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/acme/dana/seq1',
      title: 'Dana',
      contentMd: BODY,
    });
    const version = await db.query.artifactVersions.findFirst({
      where: eq(artifactVersions.requestId, request.id),
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.versionId, version!.id),
    });
    expect(run?.state).toBe('pending');
  });

  it('emits a boolean finding for every criterion', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/acme/dana/seq2',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    const result = await runOneJudge(db, run!.id, {
      scorer: fakeScorer,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(result).toBe('completed');
    const findings = await db
      .select()
      .from(machineFindings)
      .where(eq(machineFindings.requestId, request.id));
    const judged = findings.filter((f) => f.criterionKey !== 'pii');
    expect(judged.length).toBeGreaterThanOrEqual(2);
    const voice = judged.find((f) => f.criterionKey === 'voice');
    expect(voice?.passed).toBe(false);
    expect(voice?.score).toBe(0);
    const other = judged.find((f) => f.criterionKey !== 'voice');
    expect(other?.passed).toBe(true);
    expect(other?.score).toBe(1);

    const updated = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, request.id),
    });
    expect(updated?.judgeOverallScore).toBeTypeOf('number');
  });

  it('pins a hallucinated quote to the first line instead of dropping the finding', async () => {
    const hallucinating: JudgeScorer = async ({ criteria }) =>
      criteria.map((c) => ({
        criterionKey: c.key,
        score: 0,
        passed: false,
        quote: 'THIS TEXT DOES NOT EXIST IN THE ARTIFACT',
        note: 'hallucination',
      }));
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/acme/dana/seq3',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    await runOneJudge(db, run!.id, {
      scorer: hallucinating,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    const findings = await db
      .select()
      .from(machineFindings)
      .where(eq(machineFindings.requestId, request.id));
    const voice = findings.filter((f) => f.criterionKey === 'voice');
    expect(voice.length).toBeGreaterThan(0);
    expect(BODY.startsWith(voice[0].quote) || BODY.includes(voice[0].quote)).toBe(true);
  });

  it('does not enqueue a run when the judge is off', async () => {
    const off = await createFixtures({ judgeEnabled: false });
    const { request } = await createReview(db, {
      projectId: off.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/off/acme/dana/seq1',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    expect(run).toBeUndefined();
  });

  it('sampling is deterministic on the version id', () => {
    expect(isSampled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0)).toBe(false);
    expect(isSampled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 100)).toBe(true);
    const a = isSampled('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 50);
    const b = isSampled('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 50);
    expect(a).toBe(b);
  });

  it('locates a quote ignoring case and returns the artifact span', () => {
    const loc = locateQuote('Hi Dana, we sincerely apologize.', 'We Sincerely Apologize');
    expect(loc).toEqual({ startPos: 9, endPos: 31 });
  });

  it('PII regex flags an email', () => {
    const hits = detectPii(BODY);
    expect(hits.some((h) => h.selector.quote.includes('dana@acme.test'))).toBe(true);
  });

  it('never depends on the Braintrust hosted SDK', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies.braintrust).toBeUndefined();
    expect(pkg.devDependencies?.braintrust).toBeUndefined();
  });
});
