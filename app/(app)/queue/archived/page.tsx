import { redirect } from 'next/navigation';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { resolveQueue, archivedForQueue } from '@/lib/core/queue';
import { NoAccess } from '@/components/shell/NoAccess';
import { ArchivedScreen, ArchivedRowData } from '@/components/queue/ArchivedScreen';

export const dynamic = 'force-dynamic';

/**
 * The operator's undo list. Deliberately NOT part of the reviewer queue: the
 * queue is what is open, and an archived request is not.
 */
export default async function ArchivedPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; queue?: string; env?: string }>;
}) {
  const params = await searchParams;
  const user = await getUser();
  if (!user) redirect('/sign-in');
  const membership = await currentMembership(user.id);
  if (!membership) redirect('/sign-in');

  // Same boundary as archive itself. A reviewer has no business here.
  if (membership.role !== 'operator' && membership.role !== 'admin') return <NoAccess />;

  const environment = (params.env === 'test' ? 'test' : 'production') as 'test' | 'production';
  const resolved = await resolveQueue(db, {
    workspaceId: membership.workspaceId,
    projectSlug: params.project ?? null,
    queueSlug: params.queue ?? null,
    environment,
  });

  if (!resolved.queue) {
    return (
      <ArchivedScreen
        rows={[]}
        queueSlug={params.queue ?? ''}
        projectSlug={resolved.project?.slug ?? ''}
        environment={environment}
        noQueue
      />
    );
  }

  const archived = await archivedForQueue(db, resolved.queue.id);
  const rows: ArchivedRowData[] = archived.map((r) => ({
    id: r.id,
    title: r.title,
    customerRequestId: r.customerRequestId,
    status: r.status,
    round: r.round,
    archivedAt: r.archivedAt!.toISOString(),
  }));

  return (
    <ArchivedScreen
      rows={rows}
      queueSlug={resolved.queue.slug}
      projectSlug={resolved.project?.slug ?? ''}
      environment={environment}
      noQueue={false}
    />
  );
}
