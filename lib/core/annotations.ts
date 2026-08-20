import { and, eq } from 'drizzle-orm';
import {
  annotations,
  criteriaVerdicts,
  reviewRequests,
  artifactVersions,
} from '@/lib/db/schema';
import { appendEvent, Db } from './eventlog';
import { ApiProblem } from './requests';

const CONTEXT = 32;

export interface AddCommentInput {
  requestId: string;
  userId: string;
  body: string;
  expected?: string;
  startPos: number;
  endPos: number;
  parentId?: string;
}

/** Anchor a comment on the CURRENT version's content at [startPos, endPos). */
export async function addComment(db: Db, input: AddCommentInput) {
  return db.transaction(async (tx) => {
    const request = await tx.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, input.requestId),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    const version = await tx.query.artifactVersions.findFirst({
      where: and(
        eq(artifactVersions.requestId, input.requestId),
        eq(artifactVersions.versionNumber, request.round)
      ),
    });
    if (!version) throw new ApiProblem(500, 'version_missing', 'Current version missing');
    const content = version.contentMd;
    if (
      input.startPos < 0 ||
      input.endPos > content.length ||
      input.startPos >= input.endPos
    )
      throw new ApiProblem(422, 'invalid_range', 'Selection range is outside the artifact');

    const quote = content.slice(input.startPos, input.endPos);
    const [ann] = await tx
      .insert(annotations)
      .values({
        requestId: input.requestId,
        bornRound: request.round,
        bornVersionId: version.id,
        authorUserId: input.userId,
        body: input.body,
        expected: input.expected,
        quote,
        prefix: content.slice(Math.max(0, input.startPos - CONTEXT), input.startPos),
        suffix: content.slice(input.endPos, input.endPos + CONTEXT),
        startPos: input.startPos,
        endPos: input.endPos,
        parentId: input.parentId,
      })
      .returning();

    await appendEvent(tx, input.requestId, 'annotation.created', {
      annotation_id: ann.id,
      born_round: ann.bornRound,
      by: input.userId,
    });
    return ann;
  });
}

/**
 * Edit the body of a comment that has not been resolved.
 *
 * A correction is the payload that ships with a rejection, so a wrong one is
 * worse than no comment at all — and until now the only exits were "resolve"
 * and "leave it there".
 *
 * The anchor is NOT touched. The range, quote, prefix and suffix are what the
 * re-anchoring matcher works from; moving them would silently change which
 * span a persisting correction refers to. Only `body` changes, and the previous
 * body goes into the event, so the chain still holds what was originally said.
 */
export async function editComment(
  db: Db,
  input: { requestId: string; annotationId: string; userId: string; body: string }
) {
  const body = input.body.trim();
  if (!body) throw new ApiProblem(422, 'empty_body', 'A comment needs a body');
  return db.transaction(async (tx) => {
    const ann = await tx.query.annotations.findFirst({
      where: and(
        eq(annotations.id, input.annotationId),
        eq(annotations.requestId, input.requestId)
      ),
    });
    if (!ann) throw new ApiProblem(404, 'annotation_not_found', 'Comment not found');
    if (ann.resolvedAt)
      throw new ApiProblem(409, 'already_resolved', 'A resolved comment cannot be edited');
    if (ann.retiredAt)
      throw new ApiProblem(409, 'retired', 'A retired comment cannot be edited');
    if (ann.authorUserId !== input.userId)
      throw new ApiProblem(403, 'not_the_author', 'Only the author can edit a comment');
    if (ann.body === body) return ann;

    const [updated] = await tx
      .update(annotations)
      .set({ body })
      .where(eq(annotations.id, ann.id))
      .returning();

    await appendEvent(tx, input.requestId, 'annotation.edited', {
      annotation_id: ann.id,
      previous_body: ann.body,
      body,
      by: input.userId,
    });
    return updated;
  });
}

/** Resolve unblocks approve; it does NOT ship (design decision, prototype). */
export async function resolveComment(db: Db, requestId: string, annotationId: string, userId: string) {
  await db
    .update(annotations)
    .set({ resolvedAt: new Date(), resolvedBy: userId })
    .where(and(eq(annotations.id, annotationId), eq(annotations.requestId, requestId)));
}

export async function setCriterionVerdict(
  db: Db,
  input: {
    requestId: string;
    criterionId: string;
    userId: string;
    verdict: 'pass' | 'fail' | 'na';
  }
) {
  return db.transaction(async (tx) => {
    const request = await tx.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, input.requestId),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    const version = await tx.query.artifactVersions.findFirst({
      where: and(
        eq(artifactVersions.requestId, input.requestId),
        eq(artifactVersions.versionNumber, request.round)
      ),
    });
    if (!version) throw new ApiProblem(500, 'version_missing', 'Current version missing');

    await tx
      .insert(criteriaVerdicts)
      .values({
        requestId: input.requestId,
        versionId: version.id,
        criterionId: input.criterionId,
        verdict: input.verdict,
        userId: input.userId,
      })
      .onConflictDoUpdate({
        target: [criteriaVerdicts.versionId, criteriaVerdicts.criterionId, criteriaVerdicts.userId],
        set: { verdict: input.verdict, updatedAt: new Date() },
      });
  });
}
