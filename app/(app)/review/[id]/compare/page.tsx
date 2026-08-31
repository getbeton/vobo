import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import { reviewRequests, queues, projects } from '@/lib/db/schema';
import { workspaceOfRequestOrNull, canReview } from '@/lib/core/authz';
import { NoAccess } from '@/components/shell/NoAccess';
import { mergeReviewSearch } from '@/lib/shell/crumbs';

export const dynamic = 'force-dynamic';

/**
 * VOBO-288. Compare is not a station. Old bookmarks land on the workspace
 * split. Keep project/queue/env. Drop l/r.
 */
export default async function CompareRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ project?: string; queue?: string; env?: string; l?: string; r?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getUser();
  if (!user) redirect('/auth');

  const request = await db.query.reviewRequests.findFirst({ where: eq(reviewRequests.id, id) });
  if (!request) notFound();
  const wsId = await workspaceOfRequestOrNull(request.id);
  if (wsId === null || !(await canReview(user.id, wsId))) return <NoAccess />;

  const queue = await db.query.queues.findFirst({ where: eq(queues.id, request.queueId) });
  const project = await db.query.projects.findFirst({ where: eq(projects.id, request.projectId) });
  if (project && queue) {
    const filled = mergeReviewSearch(sp, {
      projectSlug: project.slug,
      queueSlug: queue.slug,
      environment: queue.environment,
    });
    redirect(`/review/${id}?${filled.search}`);
  }
  redirect(`/review/${id}`);
}
