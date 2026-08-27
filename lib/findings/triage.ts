import { and, eq, isNull } from 'drizzle-orm';
import {
  artifactVersions,
  criteria,
  criteriaVerdicts,
  dismissalMemory,
  machineFindings,
  reviewRequests,
} from '@/lib/db/schema';
import { ApiProblem } from '@/lib/core/requests';
import { appendEvent, Db, DbOrTx } from '@/lib/core/eventlog';

async function applyCriterion(
  tx: DbOrTx,
  input: {
    requestId: string;
    queueId: string;
    versionId: string;
    criterionKey: string;
    userId: string;
    verdict: 'pass' | 'fail';
  }
) {
  const [crit] = await tx
    .select()
    .from(criteria)
    .where(
      and(
        eq(criteria.queueId, input.queueId),
        eq(criteria.key, input.criterionKey),
        isNull(criteria.archivedAt)
      )
    )
    .limit(1);
  if (!crit) return;
  await tx
    .insert(criteriaVerdicts)
    .values({
      requestId: input.requestId,
      versionId: input.versionId,
      criterionId: crit.id,
      verdict: input.verdict,
      userId: input.userId,
    })
    .onConflictDoUpdate({
      target: [criteriaVerdicts.versionId, criteriaVerdicts.criterionId, criteriaVerdicts.userId],
      set: { verdict: input.verdict, updatedAt: new Date() },
    });
}

export async function confirmFinding(
  db: Db,
  input: { findingId: string; userId: string }
) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(machineFindings)
      .where(eq(machineFindings.id, input.findingId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'finding_not_found', 'Finding not found');
    if (locked.triage === 'confirmed' || locked.triage === 'dismissed')
      throw new ApiProblem(409, 'already_triaged', `Finding is ${locked.triage}`);
    if (locked.triage === 'suppressed')
      throw new ApiProblem(409, 'suppressed', 'Suppressed findings are not triaged');

    const request = await tx.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, locked.requestId),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (request.judgeBlind)
      throw new ApiProblem(409, 'judge_blind', 'Blind requests do not triage judge findings');

    await applyCriterion(tx, {
      requestId: request.id,
      queueId: request.queueId,
      versionId: locked.versionId,
      criterionKey: locked.criterionKey,
      userId: input.userId,
      verdict: 'pass',
    });

    const [updated] = await tx
      .update(machineFindings)
      .set({
        triage: 'confirmed',
        confirmedBy: input.userId,
        confirmedAt: new Date(),
      })
      .where(eq(machineFindings.id, locked.id))
      .returning();

    await appendEvent(tx, locked.requestId, 'finding.confirmed', {
      finding_id: locked.id,
      producer_id: locked.producerId,
      criterion: locked.criterionKey,
      criterion_verdict: 'pass',
      source: 'judge',
      by: input.userId,
    });
    return { finding: updated, verdict: 'pass' as const };
  });
}

export async function dismissFinding(
  db: Db,
  input: { findingId: string; userId: string; reason?: string }
) {
  const reason = (input.reason ?? 'declined').trim() || 'declined';

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(machineFindings)
      .where(eq(machineFindings.id, input.findingId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'finding_not_found', 'Finding not found');
    if (locked.triage === 'confirmed' || locked.triage === 'dismissed')
      throw new ApiProblem(409, 'already_triaged', `Finding is ${locked.triage}`);
    if (locked.triage === 'suppressed')
      throw new ApiProblem(409, 'suppressed', 'Suppressed findings are not triaged');

    const request = await tx.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, locked.requestId),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (request.judgeBlind)
      throw new ApiProblem(409, 'judge_blind', 'Blind requests do not triage judge findings');

    await applyCriterion(tx, {
      requestId: request.id,
      queueId: request.queueId,
      versionId: locked.versionId,
      criterionKey: locked.criterionKey,
      userId: input.userId,
      verdict: 'fail',
    });

    const [updated] = await tx
      .update(machineFindings)
      .set({
        triage: 'dismissed',
        dismissalReason: reason,
        dismissedBy: input.userId,
        dismissedAt: new Date(),
      })
      .where(eq(machineFindings.id, locked.id))
      .returning();

    await tx
      .insert(dismissalMemory)
      .values({
        requestId: locked.requestId,
        fingerprint: locked.fingerprint,
        reason,
        dismissedBy: input.userId,
      })
      .onConflictDoNothing();

    await appendEvent(tx, locked.requestId, 'finding.dismissed', {
      finding_id: locked.id,
      producer_id: locked.producerId,
      criterion: locked.criterionKey,
      criterion_verdict: 'fail',
      reason,
      by: input.userId,
    });
    return { finding: updated, verdict: 'fail' as const };
  });
}

export async function undismissFingerprint(
  db: Db,
  input: { requestId: string; fingerprint: string; userId: string }
) {
  return db.transaction(async (tx) => {
    await tx
      .delete(dismissalMemory)
      .where(
        and(
          eq(dismissalMemory.requestId, input.requestId),
          eq(dismissalMemory.fingerprint, input.fingerprint)
        )
      );
    await appendEvent(tx, input.requestId, 'finding.undismissed', {
      fingerprint: input.fingerprint,
      by: input.userId,
    });
  });
}
