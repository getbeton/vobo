import { eq } from 'drizzle-orm';
import { judgeRuns, policyVersions, reviewRequests } from '@/lib/db/schema';
import { parsePolicyConfig } from '@/lib/core/policy';
import { DbOrTx } from '@/lib/core/eventlog';
import { isSampled } from './sampling';

/**
 * Insert a judge_run for a newly submitted version. Idempotent on version id.
 * Blindness is a property of the request and is stamped only on v1.
 */
export async function enqueueJudgeRun(
  tx: DbOrTx,
  input: { requestId: string; versionId: string; versionNumber: number }
) {
  const request = await tx.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, input.requestId),
  });
  if (!request) return null;
  const pv = await tx.query.policyVersions.findFirst({
    where: eq(policyVersions.id, request.policyVersionId),
  });
  if (!pv) return null;
  const policy = parsePolicyConfig(pv.config);

  if (input.versionNumber === 1 && policy.judgeBlindSamplingPct > 0) {
    const blind = isSampled(request.id, policy.judgeBlindSamplingPct);
    if (blind !== request.judgeBlind) {
      await tx
        .update(reviewRequests)
        .set({ judgeBlind: blind, updatedAt: new Date() })
        .where(eq(reviewRequests.id, request.id));
    }
  }

  if (!policy.judgeEnabled) return null;

  const sampled = isSampled(input.versionId, policy.judgeSamplingPct);
  const existing = await tx.query.judgeRuns.findFirst({
    where: eq(judgeRuns.versionId, input.versionId),
  });
  if (existing) return existing;

  const [row] = await tx
    .insert(judgeRuns)
    .values({
      requestId: request.id,
      versionId: input.versionId,
      policyVersionId: request.policyVersionId,
      state: sampled ? 'pending' : 'not_sampled',
    })
    .onConflictDoNothing()
    .returning();
  return row ?? existing;
}
