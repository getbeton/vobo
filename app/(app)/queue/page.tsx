import { redirect } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { anchorStates, annotations, artifactVersions } from '@/lib/db/schema';
import { rankedQueue, resolveQueue } from '@/lib/core/queue';
import { remainingWorkForQueue } from '@/lib/core/remaining-work';
import { QueueScreen, QueueRowData, QueueMiss } from '@/components/queue/QueueScreen';

export const dynamic = 'force-dynamic';

function failingHref(params: { project?: string; queue?: string; env?: string }) {
  const q = new URLSearchParams();
  if (params.project) q.set('project', params.project);
  if (params.queue) q.set('queue', params.queue);
  q.set('env', params.env === 'test' ? 'test' : 'production');
  return `/queue/failing?${q.toString()}`;
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; queue?: string; env?: string }>;
}) {
  const params = await searchParams;
  const user = await getUser();
  if (!user) redirect('/auth');
  const membership = await currentMembership(user.id);
  if (!membership) redirect('/auth');

  // Archive removes work from the board without a verdict, so it sits with
  // whoever owns the queue, not with every reviewer.
  const canArchive = membership.role === 'operator' || membership.role === 'admin';

  const environment = (params.env === 'test' ? 'test' : 'production') as 'test' | 'production';

  // VOBO-204: one resolver for the whole workspace. The page no longer picks a
  // project of its own, so a slug that lives in the second project resolves.
  const resolved = await resolveQueue(db, {
    workspaceId: membership.workspaceId,
    projectSlug: params.project ?? null,
    queueSlug: params.queue ?? null,
    environment,
  });

  if (!resolved.queue) {
    const miss: QueueMiss = {
      kind: resolved.reason ?? 'no_queues',
      askedFor: params.queue ?? null,
      askedProject: params.project ?? null,
      projectSlug: resolved.project?.slug ?? null,
      projectName: resolved.project?.name ?? null,
      available: resolved.workspaceQueues,
      environment,
    };
    return (
      <QueueScreen
        rows={[]}
        nextUp={null}
        miss={miss}
        canArchive={canArchive}
        failingHref={canArchive ? failingHref(params) : null}
      />
    );
  }
  const queue = resolved.queue;
  const archivedHref = `/queue/archived?project=${encodeURIComponent(
    resolved.project?.slug ?? ''
  )}&queue=${encodeURIComponent(queue.slug)}&env=${environment}`;

  const ranked = await rankedQueue(db, queue.id, user.id);
  const remaining = await remainingWorkForQueue(db, queue.id);

  const rows: QueueRowData[] = [];
  for (const r of ranked) {
    // Persisting count on the current version (loud badge per the prototype).
    let persisting = 0;
    if (r.request.round > 1) {
      const currentVersion = await db.query.artifactVersions.findFirst({
        where: and(
          eq(artifactVersions.requestId, r.request.id),
          eq(artifactVersions.versionNumber, r.request.round)
        ),
      });
      if (currentVersion) {
        const states = await db
          .select({ id: anchorStates.id })
          .from(anchorStates)
          .innerJoin(annotations, eq(annotations.id, anchorStates.annotationId))
          .where(
            and(
              eq(anchorStates.versionId, currentVersion.id),
              eq(anchorStates.state, 'persisting'),
              isNull(annotations.retiredAt)
            )
          );
        persisting = states.length;
      }
    }
    rows.push({
      id: r.request.id,
      title: r.request.title,
      round: r.request.round,
      status: r.request.status,
      slaDueAt: r.request.slaDueAt?.toISOString() ?? null,
      priority: r.request.priority,
      sticky: r.sticky,
      persisting,
      rankRationale: r.rankRationale,
      lease: r.lease
        ? {
            mine: r.lease.userId === user.id,
            expiresAt: r.lease.expiresAt.toISOString(),
          }
        : null,
    });
  }

  const nextUp =
    rows.find((r) => r.status === 'open' || (r.lease?.mine ?? false)) ?? null;

  return (
    <QueueScreen
      rows={rows}
      nextUp={nextUp}
      miss={null}
      canArchive={canArchive}
      archivedHref={archivedHref}
      failingHref={canArchive ? failingHref(params) : null}
      queueRef={{
        projectSlug: resolved.project?.slug ?? '',
        queueSlug: queue.slug,
        environment,
      }}
      remainingWork={remaining}
    />
  );
}
