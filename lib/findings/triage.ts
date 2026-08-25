import { and, eq } from 'drizzle-orm';
import {
  annotations,
  artifactVersions,
  dismissalMemory,
  machineFindings,
  reviewRequests,
} from '@/lib/db/schema';
import { ApiProblem } from '@/lib/core/requests';
import { appendEvent, Db } from '@/lib/core/eventlog';
import { quoteContext } from './fingerprint';

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

    const version = await tx.query.artifactVersions.findFirst({
      where: eq(artifactVersions.id, locked.versionId),
    });
    if (!version) throw new ApiProblem(500, 'version_missing', 'Version missing');
    const ctx = quoteContext(version.contentMd, locked.startPos, locked.endPos);

    const [ann] = await tx
      .insert(annotations)
      .values({
        requestId: locked.requestId,
        bornRound: request.round,
        bornVersionId: locked.versionId,
        authorUserId: input.userId,
        body: locked.note,
        expected: locked.note,
        quote: locked.quote,
        prefix: ctx.prefix,
        suffix: ctx.suffix,
        startPos: locked.startPos,
        endPos: locked.endPos,
      })
      .returning();

    const [updated] = await tx
      .update(machineFindings)
      .set({
        triage: 'confirmed',
        confirmedAnnotationId: ann.id,
        confirmedBy: input.userId,
        confirmedAt: new Date(),
      })
      .where(eq(machineFindings.id, locked.id))
      .returning();

    await appendEvent(tx, locked.requestId, 'finding.confirmed', {
      finding_id: locked.id,
      annotation_id: ann.id,
      producer_id: locked.producerId,
      criterion: locked.criterionKey,
      source: 'judge',
      by: input.userId,
    });
    await appendEvent(tx, locked.requestId, 'annotation.created', {
      annotation_id: ann.id,
      born_round: ann.bornRound,
      by: input.userId,
      source: 'judge',
      finding_id: locked.id,
    });
    return { finding: updated, annotation: ann };
  });
}

export async function dismissFinding(
  db: Db,
  input: { findingId: string; userId: string; reason: string }
) {
  const reason = input.reason.trim();
  if (!reason) throw new ApiProblem(400, 'reason_required', 'A dismiss reason is required');

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
      reason,
      by: input.userId,
    });
    return { finding: updated };
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
