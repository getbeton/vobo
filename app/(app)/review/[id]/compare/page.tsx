import { notFound, redirect } from 'next/navigation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import {
  reviewRequests,
  artifactVersions,
  annotations,
  anchorStates,
  criteria,
  criteriaVerdicts,
  policyVersions,
} from '@/lib/db/schema';
import { workspaceOfRequest, can } from '@/lib/core/authz';
import { parsePolicyConfig } from '@/lib/core/policy';
import { VersionCompare } from '@/components/review/VersionCompare';

export const dynamic = 'force-dynamic';

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ l?: string; r?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getUser();
  if (!user) redirect('/sign-in');

  const request = await db.query.reviewRequests.findFirst({ where: eq(reviewRequests.id, id) });
  if (!request) notFound();
  const wsId = await workspaceOfRequest(request.id);
  await can.review(user.id, wsId);

  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.requestId, request.id))
    .orderBy(asc(artifactVersions.versionNumber));
  if (versions.length < 2) redirect(`/review/${request.id}`);

  const rNum = Math.min(Number(sp.r) || request.round, versions.length);
  const lNum = Math.min(Number(sp.l) || Math.max(1, rNum - 1), rNum - 1) || 1;
  const left = versions.find((v) => v.versionNumber === lNum)!;
  const right = versions.find((v) => v.versionNumber === rNum)!;

  const anns = await db
    .select({ ann: annotations, state: anchorStates })
    .from(annotations)
    .leftJoin(
      anchorStates,
      and(eq(anchorStates.annotationId, annotations.id), eq(anchorStates.versionId, right.id))
    )
    .where(and(eq(annotations.requestId, request.id), isNull(annotations.retiredAt)));

  const crits = await db
    .select()
    .from(criteria)
    .where(and(eq(criteria.queueId, request.queueId), isNull(criteria.archivedAt)))
    .orderBy(asc(criteria.position));
  const verdicts = await db
    .select()
    .from(criteriaVerdicts)
    .where(and(eq(criteriaVerdicts.versionId, right.id), eq(criteriaVerdicts.userId, user.id)));

  const pv = await db.query.policyVersions.findFirst({
    where: eq(policyVersions.id, request.policyVersionId),
  });
  const policy = pv ? parsePolicyConfig(pv.config) : null;

  return (
    <VersionCompare
      request={{
        id: request.id,
        title: request.title,
        round: request.round,
        roundBudget: policy?.roundBudget ?? 3,
        status: request.status,
      }}
      left={{
        number: left.versionNumber,
        content: left.contentMd,
        author: left.authorLabel ?? '',
        hash: left.contentHash,
      }}
      right={{
        number: right.versionNumber,
        content: right.contentMd,
        author: right.authorLabel ?? '',
        hash: right.contentHash,
        id: right.id,
      }}
      versions={versions.map((v) => ({
        number: v.versionNumber,
        author: v.authorLabel ?? '',
        hash: v.contentHash.slice(0, 8),
        human: v.humanAuthored,
      }))}
      findings={anns.map(({ ann, state }) => ({
        id: ann.id,
        body: ann.body,
        expected: ann.expected,
        quote: ann.quote,
        startPos: ann.startPos,
        endPos: ann.endPos,
        bornRound: ann.bornRound,
        resolvedComment: Boolean(ann.resolvedAt),
        state: state?.state ?? (ann.bornRound === request.round ? 'new' : null),
        confidence: state?.confidence ?? null,
        confirmation: state?.confirmation ?? null,
        landing:
          state?.newStartPos !== null && state?.newStartPos !== undefined
            ? { start: state.newStartPos, end: state.newEndPos ?? state.newStartPos, quote: state.newQuote ?? '' }
            : null,
      }))}
      criteriaScored={crits.length - verdicts.length === 0}
      unscoredCount={crits.length - verdicts.length}
    />
  );
}
