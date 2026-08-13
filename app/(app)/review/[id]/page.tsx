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
  contextFiles,
} from '@/lib/db/schema';
import { workspaceOfRequestOrNull, canReview } from '@/lib/core/authz';
import { NoAccess } from '@/components/shell/NoAccess';
import { parsePolicyConfig } from '@/lib/core/policy';
import { ReviewWorkspace } from '@/components/review/ReviewWorkspace';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) redirect('/sign-in');

  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, id),
  });
  if (!request) notFound();
  const wsId = await workspaceOfRequestOrNull(request.id);
  if (wsId === null || !(await canReview(user.id, wsId))) return <NoAccess />;

  const version = await db.query.artifactVersions.findFirst({
    where: and(
      eq(artifactVersions.requestId, request.id),
      eq(artifactVersions.versionNumber, request.round)
    ),
  });
  if (!version) notFound();

  const anns = await db
    .select({ ann: annotations, state: anchorStates })
    .from(annotations)
    .leftJoin(
      anchorStates,
      and(eq(anchorStates.annotationId, annotations.id), eq(anchorStates.versionId, version.id))
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
    .where(and(eq(criteriaVerdicts.versionId, version.id), eq(criteriaVerdicts.userId, user.id)));

  const files = await db
    .select()
    .from(contextFiles)
    .where(eq(contextFiles.requestId, request.id));

  const pv = await db.query.policyVersions.findFirst({
    where: eq(policyVersions.id, request.policyVersionId),
  });
  const policy = pv ? parsePolicyConfig(pv.config) : null;

  return (
    <ReviewWorkspace
      request={{
        id: request.id,
        title: request.title,
        status: request.status,
        round: request.round,
        prompt: request.prompt,
        source: request.source,
        policyLabel: pv ? `policy v${pv.version}` : '',
        roundBudget: policy?.roundBudget ?? 3,
      }}
      contentMd={version.contentMd}
      versionId={version.id}
      annotations={anns.map(({ ann, state }) => ({
        id: ann.id,
        body: ann.body,
        expected: ann.expected,
        quote: ann.quote,
        startPos: ann.startPos,
        endPos: ann.endPos,
        bornRound: ann.bornRound,
        resolved: Boolean(ann.resolvedAt),
        state: state?.state ?? (ann.bornRound === request.round ? 'new' : null),
        confirmation: state?.confirmation ?? null,
      }))}
      criteria={crits.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        verdict: verdicts.find((v) => v.criterionId === c.id)?.verdict ?? null,
      }))}
      files={files.map((f) => ({ name: f.name, kind: f.contentType ?? 'file' }))}
    />
  );
}
