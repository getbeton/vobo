import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  artifactVersions,
  criteria,
  judgeRuns,
  policyVersions,
  projects,
  reviewRequests,
} from '@/lib/db/schema';
import { parsePolicyConfig } from '@/lib/core/policy';
import { appendEvent, Db } from '@/lib/core/eventlog';
import { ingestFindings } from '@/lib/findings/ingest';
import { locateQuote } from '@/lib/findings/fingerprint';
import { BUILTIN_JUDGE_SLUG, BUILTIN_PII_SLUG, ensureBuiltinProducer } from '@/lib/findings/producers';
import { detectPii } from './pii';
import { appendJudgeRecord } from './records';
import type { JudgeScorer } from './scorer';
import { autoevalsScorer } from './autoevals';

const BACKOFF_SECONDS = [10, 60, 180];
export const MAX_JUDGE_ATTEMPTS = BACKOFF_SECONDS.length;

export interface JudgeDeps {
  scorer?: JudgeScorer;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

function keyFromEnv(env: Record<string, string | undefined>, name: string): string | null {
  const v = env[name];
  return v && v.length > 0 ? v : null;
}

export async function dueJudgeRuns(db: Db, limit = 10) {
  return db
    .select()
    .from(judgeRuns)
    .where(inArray(judgeRuns.state, ['pending', 'failed']))
    .orderBy(judgeRuns.createdAt)
    .limit(limit);
}

export async function runOneJudge(db: Db, runId: string, deps: JudgeDeps = {}) {
  const scorer = deps.scorer ?? autoevalsScorer;
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();

  const [run] = await db.select().from(judgeRuns).where(eq(judgeRuns.id, runId)).limit(1);
  if (!run) return 'skipped' as const;
  if (!['pending', 'failed'].includes(run.state)) return 'skipped' as const;
  if (run.lastAttemptAt) {
    const wait = BACKOFF_SECONDS[Math.min(Math.max(run.attempts - 1, 0), BACKOFF_SECONDS.length - 1)];
    if (run.lastAttemptAt.getTime() + wait * 1000 > now.getTime()) return 'skipped' as const;
  }

  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, run.requestId),
  });
  const version = await db.query.artifactVersions.findFirst({
    where: eq(artifactVersions.id, run.versionId),
  });
  const pv = await db.query.policyVersions.findFirst({
    where: eq(policyVersions.id, run.policyVersionId),
  });
  if (!request || !version || !pv) return 'skipped' as const;
  const policy = parsePolicyConfig(pv.config);

  await db
    .update(judgeRuns)
    .set({
      state: 'running',
      attempts: run.attempts + 1,
      lastAttemptAt: now,
      startedAt: run.startedAt ?? now,
    })
    .where(eq(judgeRuns.id, run.id));

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, request.projectId),
  });
  if (!project) return 'skipped' as const;

  const judgeProducer = await ensureBuiltinProducer(
    db,
    project.id,
    BUILTIN_JUDGE_SLUG,
    'Vobo built-in judge'
  );
  const piiProducer = await ensureBuiltinProducer(db, project.id, BUILTIN_PII_SLUG, 'PII regex');

  try {
    if (policy.piiDetection) {
      const pii = detectPii(version.contentMd);
      if (pii.length) {
        await ingestFindings(db, {
          requestId: request.id,
          versionId: version.id,
          producerId: piiProducer.id,
          idempotencyKey: `pii:${version.id}`,
          findings: pii,
          judgeRunId: run.id,
        });
      }
    }

    const apiKey = keyFromEnv(env, policy.judgeKeyEnv);
    if (!apiKey) {
      throw Object.assign(new Error(`env ${policy.judgeKeyEnv} is not set`), {
        class: 'missing_key',
      });
    }

    const activeCriteria = await db
      .select()
      .from(criteria)
      .where(and(eq(criteria.queueId, request.queueId), isNull(criteria.archivedAt)));

    const bound =
      policy.judgeBindings.length > 0
        ? activeCriteria.filter((c) =>
            policy.judgeBindings.some((b) => b.criterionKey === c.key)
          )
        : activeCriteria;

    const scores = bound.length
      ? await scorer({
          contentMd: version.contentMd,
          prompt: request.prompt ?? '',
          source: request.source ?? '',
          criteria: bound.map((c) => ({
            key: c.key,
            title: c.title,
            description: c.description,
          })),
          modelId: policy.judgeModelId,
          baseUrl: policy.judgeBaseUrl,
          apiKey,
          minScore: policy.judgeMinScore,
        })
      : [];

    const findings = [];
    let dropped = 0;
    for (const s of scores) {
      let loc = s.quote ? locateQuote(version.contentMd, s.quote) : null;
      if (!loc) {
        dropped += 1;
        const line =
          version.contentMd.split('\n').find((l) => l.trim().length > 0) ??
          version.contentMd.slice(0, Math.min(80, version.contentMd.length));
        const start = Math.max(0, version.contentMd.indexOf(line));
        loc = { startPos: start, endPos: start + line.length };
      }
      const actual = version.contentMd.slice(loc.startPos, loc.endPos);
      findings.push({
        criterion: s.criterionKey,
        passed: s.passed,
        severity: s.passed ? ('minor' as const) : ('minor' as const),
        selector: { quote: actual, start: loc.startPos, end: loc.endPos },
        evidence: actual,
        note: s.note,
      });
    }

    if (findings.length) {
      await ingestFindings(db, {
        requestId: request.id,
        versionId: version.id,
        producerId: judgeProducer.id,
        idempotencyKey: `judge:${run.id}`,
        findings,
        judgeRunId: run.id,
      });
    }

    const overall =
      scores.length === 0
        ? 1
        : scores.reduce((acc, s) => acc + s.score, 0) / scores.length;

    await db
      .update(judgeRuns)
      .set({
        state: 'completed',
        overallScore: overall,
        completedAt: new Date(),
        errorClass: null,
        errorMessage: dropped ? `dropped_unanchored:${dropped}` : null,
      })
      .where(eq(judgeRuns.id, run.id));

    await db
      .update(reviewRequests)
      .set({ judgeOverallScore: overall, updatedAt: new Date() })
      .where(eq(reviewRequests.id, request.id));

    await db.transaction(async (tx) => {
      await appendEvent(tx, request.id, 'judge.completed', {
        run_id: run.id,
        version_id: version.id,
        overall_score: overall,
        finding_count: findings.length,
        dropped_unanchored: dropped,
      });
    });

    await appendJudgeRecord(db, {
      workspaceId: project.workspaceId,
      requestId: request.id,
      versionId: version.id,
      runId: run.id,
      payload: {
        overall_score: overall,
        model: policy.judgeModelId,
        dropped_unanchored: dropped,
        scores: scores.map((s) => ({
          criterion: s.criterionKey,
          score: s.score,
          passed: s.passed,
        })),
      },
    });

    return 'completed' as const;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorClass =
      (err as { class?: string }).class ??
      (message.startsWith('provider_') ? 'provider' : 'scorer');
    const attempts = run.attempts + 1;
    const dead = attempts >= MAX_JUDGE_ATTEMPTS;
    await db
      .update(judgeRuns)
      .set({
        state: dead ? 'failed' : 'failed',
        errorClass,
        errorMessage: message.slice(0, 500),
        lastAttemptAt: now,
        attempts,
      })
      .where(eq(judgeRuns.id, run.id));

    await db.transaction(async (tx) => {
      await appendEvent(tx, request.id, dead ? 'judge.failed' : 'judge.retry', {
        run_id: run.id,
        error_class: errorClass,
        attempts,
      });
    });
    return dead ? ('dead' as const) : ('failed' as const);
  }
}

export async function dispatchDueJudgeRuns(db: Db, deps: JudgeDeps = {}) {
  const due = await dueJudgeRuns(db);
  let n = 0;
  for (const run of due) {
    const result = await runOneJudge(db, run.id, deps);
    if (result === 'completed') n += 1;
  }
  return n;
}