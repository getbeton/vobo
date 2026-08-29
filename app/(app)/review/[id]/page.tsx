import { notFound, redirect } from 'next/navigation';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
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
  queues,
  projects,
  judgeRecords,
} from '@/lib/db/schema';
import { workspaceOfRequestOrNull, canReview } from '@/lib/core/authz';
import { NoAccess } from '@/components/shell/NoAccess';
import { parsePolicyConfig } from '@/lib/core/policy';
import { ReviewWorkspace } from '@/components/review/ReviewWorkspace';
import { readFindings } from '@/lib/findings/read';
import { mergeReviewSearch } from '@/lib/shell/crumbs';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ project?: string; queue?: string; env?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getUser();
  if (!user) redirect('/auth');

  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, id),
  });
  if (!request) notFound();
  const wsId = await workspaceOfRequestOrNull(request.id);
  if (wsId === null || !(await canReview(user.id, wsId))) return <NoAccess />;

  // The machine-review empty state links to the queue that governs this
  // review, so both slugs travel with the request.
  const queue = await db.query.queues.findFirst({ where: eq(queues.id, request.queueId) });
  const project = await db.query.projects.findFirst({ where: eq(projects.id, request.projectId) });
  if (project && queue) {
    const filled = mergeReviewSearch(sp, {
      projectSlug: project.slug,
      queueSlug: queue.slug,
      environment: queue.environment,
    });
    if (filled.changed) redirect(`/review/${id}?${filled.search}`);
  }

  const version = await db.query.artifactVersions.findFirst({
    where: and(
      eq(artifactVersions.requestId, request.id),
      eq(artifactVersions.versionNumber, request.round)
    ),
  });
  if (!version) notFound();

  const previous =
    request.round >= 2
      ? await db.query.artifactVersions.findFirst({
          where: and(
            eq(artifactVersions.requestId, request.id),
            eq(artifactVersions.versionNumber, request.round - 1)
          ),
        })
      : null;

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

  const machine = await readFindings(db, {
    requestId: request.id,
    versionId: version.id,
    audience: 'reviewer',
  });

  const [latestRecord] = await db
    .select()
    .from(judgeRecords)
    .where(eq(judgeRecords.versionId, version.id))
    .orderBy(desc(judgeRecords.id))
    .limit(1);
  const recordScores = (
    latestRecord?.payload as { scores?: Array<{ criterion?: string; score?: number }> } | null
  )?.scores;
  const scoreByKey = Object.fromEntries(
    (recordScores ?? [])
      .filter((s) => typeof s.criterion === 'string' && typeof s.score === 'number')
      .map((s) => [s.criterion as string, s.score as number])
  );

  return (
    <ReviewWorkspace
      request={{
        id: request.id,
        title: request.title,
        status: request.status,
        round: request.round,
        prompt: request.prompt,
        source: request.source,
        queueSlug: queue?.slug ?? '',
        projectSlug: project?.slug ?? '',
        environment: queue?.environment ?? 'production',
        policyLabel: pv ? `policy v${pv.version}` : '',
        roundBudget: policy?.roundBudget ?? 3,
        budgetExhausted: Boolean(request.budgetExhaustedAt),
      }}
      contentMd={version.contentMd}
      previousContentMd={previous?.contentMd ?? null}
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
        confidence: state?.confidence ?? null,
        landing:
          state?.newStartPos != null
            ? {
                start: state.newStartPos,
                end: state.newEndPos ?? state.newStartPos,
                quote: state.newQuote ?? '',
              }
            : null,
      }))}
      criteria={crits.map((c) => {
        const human = verdicts.find((v) => v.criterionId === c.id)?.verdict ?? null;
        const machineRow = machine.withheld
          ? undefined
          : machine.findings.find((f) => f.criterionKey === c.key);
        const machineVerdict =
          machineRow && 'passed' in machineRow
            ? machineRow.passed
              ? ('pass' as const)
              : ('fail' as const)
            : null;
        const columnScore =
          machineRow && 'score' in machineRow && machineRow.score != null
            ? Number(machineRow.score)
            : null;
        const score = machine.withheld ? null : (columnScore ?? scoreByKey[c.key] ?? null);
        return {
          id: c.id,
          key: c.key,
          title: c.title,
          description: c.description,
          verdict: human ?? machineVerdict,
          source: human ? ('human' as const) : machineVerdict ? ('machine' as const) : null,
          score,
          finding:
            machineRow && !machine.withheld
              ? {
                  startPos: machineRow.startPos,
                  endPos: machineRow.endPos,
                  passed: 'passed' in machineRow ? Boolean(machineRow.passed) : false,
                  note: machineRow.note,
                }
              : null,
        };
      })}
      files={files.map((f) => ({ name: f.name, kind: f.contentType ?? 'file' }))}
      machineReview={{
        withheld: machine.withheld,
        pending: machine.run?.state === 'pending' || machine.run?.state === 'running',
        failed: machine.run?.state === 'failed',
        overallScore: machine.run?.overallScore ?? request.judgeOverallScore ?? null,
      }}
    />
  );
}
