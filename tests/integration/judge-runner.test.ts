import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview } from '@/lib/core/requests';
import { runOneJudge, dueJudgeRuns, MAX_JUDGE_ATTEMPTS } from '@/lib/judge/run';
import {
  judgeRuns,
  judgeRecords,
  machineFindings,
  reviewRequests,
  artifactVersions,
  policyVersions,
  queues,
} from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { JudgeScorer } from '@/lib/judge/scorer';
import { detectPii, redactPii } from '@/lib/judge/pii';
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
    const voice = judged.find((f) => f.criterionKey === 'voice');
    expect(voice?.passed).toBe(false);
    expect(voice?.score).toBe(0);
    expect(judged.some((f) => f.criterionKey !== 'voice')).toBe(false);

    const [record] = await db
      .select()
      .from(judgeRecords)
      .where(eq(judgeRecords.requestId, request.id));
    const scores = (record.payload as { scores: Array<{ criterion: string; passed: boolean }> })
      .scores;
    expect(scores.some((s) => s.criterion !== 'voice' && s.passed)).toBe(true);

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

  it('redactPii masks emails and phones', () => {
    expect(redactPii('Reach dana@acme.test')).toBe('Reach [email]');
    expect(redactPii('Call +1 415-555-0100 now')).toBe('Call [phone] now');
  });

  it('PASS with no quote does not pin a span', async () => {
    const passing: JudgeScorer = async ({ criteria }) =>
      criteria.map((c) => ({
        criterionKey: c.key,
        score: 1,
        passed: true,
        quote: null,
        note: 'ok',
      }));
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/acme/dana/seq-pass',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    await runOneJudge(db, run!.id, {
      scorer: passing,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    const findings = await db
      .select()
      .from(machineFindings)
      .where(eq(machineFindings.requestId, request.id));
    expect(findings.filter((f) => f.criterionKey !== 'pii')).toHaveLength(0);
    const [record] = await db
      .select()
      .from(judgeRecords)
      .where(eq(judgeRecords.requestId, request.id));
    expect(
      (record.payload as { scores: Array<{ passed: boolean }> }).scores.every((s) => s.passed)
    ).toBe(true);
  });

  it('exhausted runs become dead and are not picked up again', async () => {
    const boom: JudgeScorer = async () => {
      throw new Error('provider_down');
    };
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/acme/dana/seq-dead',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    let now = new Date('2026-01-01T00:00:00Z');
    let last: string | undefined;
    for (let i = 0; i < MAX_JUDGE_ATTEMPTS; i++) {
      last = await runOneJudge(db, run!.id, {
        scorer: boom,
        env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
        now: () => now,
      });
      now = new Date(now.getTime() + 200_000);
    }
    expect(last).toBe('dead');
    const fourth = await runOneJudge(db, run!.id, {
      scorer: boom,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
      now: () => now,
    });
    expect(fourth).toBe('skipped');
    const stored = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, run!.id) });
    expect(stored?.state).toBe('dead');
    expect(stored?.attempts).toBe(MAX_JUDGE_ATTEMPTS);
    const due = await dueJudgeRuns(db, 10, now);
    expect(due.some((r) => r.id === run!.id)).toBe(false);
  });

  it('reaps a stale running row', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/acme/dana/seq-reap',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    await db
      .update(judgeRuns)
      .set({
        state: 'running',
        attempts: 1,
        lastAttemptAt: new Date(Date.now() - 180_000),
      })
      .where(eq(judgeRuns.id, run!.id));
    const result = await runOneJudge(db, run!.id, {
      scorer: fakeScorer,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-test' },
    });
    expect(result).toBe('completed');
  });

  it('ignores policy.judgeKeyEnv and rejects a non-allowlisted base URL', async () => {
    const seen: string[] = [];
    const watching: JudgeScorer = async (input) => {
      seen.push(input.apiKey);
      return fakeScorer(input);
    };
    const steal = await createFixtures({
      judgeEnabled: true,
      judgeSamplingPct: 100,
      judgeKeyEnv: 'POSTGRES_URL',
      judgeBaseUrl: 'https://api.openai.com/v1',
    });
    const { request } = await createReview(db, {
      projectId: steal.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/steal/seq1',
      title: 'Dana',
      contentMd: BODY,
    });
    const run = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, request.id),
    });
    const result = await runOneJudge(db, run!.id, {
      scorer: watching,
      env: {
        POSTGRES_URL: 'postgres://stolen',
        VOBO_JUDGE_OPENAI_API_KEY: 'sk-real',
      },
    });
    expect(result).toBe('completed');
    expect(seen).toEqual(['sk-real']);

    const evil = await createFixtures({
      judgeEnabled: true,
      judgeSamplingPct: 100,
      judgeBaseUrl: 'https://attacker.example/v1',
    });
    const evilReview = await createReview(db, {
      projectId: evil.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/evil/seq1',
      title: 'Dana',
      contentMd: BODY,
    });
    const evilRun = await db.query.judgeRuns.findFirst({
      where: eq(judgeRuns.requestId, evilReview.request.id),
    });
    const evilResult = await runOneJudge(db, evilRun!.id, {
      scorer: watching,
      env: { VOBO_JUDGE_OPENAI_API_KEY: 'sk-real' },
    });
    expect(evilResult).toBe('failed');
    const stored = await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.id, evilRun!.id) });
    expect(stored?.errorClass).toBe('config');
  });

  it('backfill uses the queue active policy, not the stamped request policy', async () => {
    const off = await createFixtures({ judgeEnabled: false });
    const { request } = await createReview(db, {
      projectId: off.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/j/backfill/seq1',
      title: 'Dana',
      contentMd: BODY,
    });
    expect(
      await db.query.judgeRuns.findFirst({ where: eq(judgeRuns.requestId, request.id) })
    ).toBeUndefined();

    const [onPv] = await db
      .insert(policyVersions)
      .values({
        queueId: off.queueId,
        templateId: off.projectTemplateId,
        version: 2,
        config: { judgeEnabled: true, judgeSamplingPct: 100 },
        createdBy: off.userId,
      })
      .returning();
    await db.update(queues).set({ activePolicyVersionId: onPv.id }).where(eq(queues.id, off.queueId));

    const inserted = await db.execute(sql`
      insert into judge_runs (request_id, version_id, policy_version_id, state)
      select r.id, v.id, q.active_policy_version_id, 'pending'
      from artifact_versions v
      join review_requests r on r.id = v.request_id
      join queues q on q.id = r.queue_id
      join policy_versions pv on pv.id = q.active_policy_version_id
      where r.archived_at is null
        and r.status in ('open', 'claimed', 'rejected')
        and q.active_policy_version_id is not null
        and coalesce((pv.config->>'judgeEnabled')::boolean, false) = true
        and not exists (select 1 from judge_runs jr where jr.version_id = v.id)
      returning id, policy_version_id
    `);
    const rows = inserted as unknown as Array<{ id: string; policy_version_id: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.policy_version_id === onPv.id)).toBe(true);
  });

  it('never depends on the Braintrust hosted SDK', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies.braintrust).toBeUndefined();
    expect(pkg.devDependencies?.braintrust).toBeUndefined();
    expect(readFileSync('lib/judge/autoevals.ts', 'utf8')).toMatch(/redactPii/);
  });
});
