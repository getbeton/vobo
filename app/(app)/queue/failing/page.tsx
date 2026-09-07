import { redirect } from 'next/navigation';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { canOperate } from '@/lib/core/authz';
import { resolveQueue } from '@/lib/core/queue';
import { listFailingRequests } from '@/lib/core/failing';
import { NoAccess } from '@/components/shell/NoAccess';
import { FailingScreen, FailingRowData } from '@/components/queue/FailingScreen';
import { QueueMiss } from '@/components/queue/QueueScreen';

export const dynamic = 'force-dynamic';

function queueHref(params: { project?: string; queue?: string; env?: string }) {
  const q = new URLSearchParams();
  if (params.project) q.set('project', params.project);
  if (params.queue) q.set('queue', params.queue);
  q.set('env', params.env === 'test' ? 'test' : 'production');
  return `/queue?${q.toString()}`;
}

export default async function FailingQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; queue?: string; env?: string }>;
}) {
  const params = await searchParams;
  const user = await getUser();
  if (!user) redirect('/auth');
  const membership = await currentMembership(user.id);
  if (!membership) redirect('/auth');

  if (!(await canOperate(user.id, membership.workspaceId))) {
    return (
      <NoAccess detail="This page lists requests that used the last policy round. It is for operators and admins." />
    );
  }

  const environment = (params.env === 'test' ? 'test' : 'production') as 'test' | 'production';
  const href = queueHref(params);

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
    return <FailingScreen rows={[]} queueId={null} queueHref={href} miss={miss} />;
  }

  const listed = await listFailingRequests(db, { queueId: resolved.queue.id });
  const rows: FailingRowData[] = listed.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    round: r.round,
    roundBudget: r.roundBudget,
    queueSlug: r.queueSlug,
    flaggedAt: r.flaggedAt.toISOString(),
    lastDecisionKind: r.lastDecisionKind,
    customerRequestId: r.customerRequestId,
    archivedAt: r.archivedAt?.toISOString() ?? null,
  }));

  return <FailingScreen rows={rows} queueId={resolved.queue.id} queueHref={href} miss={null} />;
}
