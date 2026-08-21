import { redirect } from 'next/navigation';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Suspense } from 'react';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { workspaces, projects, queues, events, reviewRequests } from '@/lib/db/schema';
import { AppShell, ShellData } from '@/components/shell/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/sign-in');

  const membership = await currentMembership(user.id);
  if (!membership) redirect('/sign-in');

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, membership.workspaceId),
  });

  // VOBO-206: the layout used to fetch ONE project with an unordered
  // `findFirst`, so a project menu had no data to render and the crumb could
  // point at a different project than the body. Load them all, ordered.
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, membership.workspaceId))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const projectIds = projectRows.map((p) => p.id);

  const queueRows = projectIds.length
    ? await db
        .select()
        .from(queues)
        .where(inArray(queues.projectId, projectIds))
        .orderBy(asc(queues.createdAt), asc(queues.id))
    : [];

  // Operator alert feed: recent load-bearing events across THIS workspace. The
  // join had no project predicate at all, so another tenant's escalation would
  // have appeared in the bell.
  const alertTypes = [
    'decision.escalated',
    'correction.persisting',
    'sla.timeout',
    'request.budget_exhausted',
  ];
  const alertRows = projectIds.length
    ? await db
        .select({ event: events, request: reviewRequests })
        .from(events)
        .innerJoin(reviewRequests, eq(reviewRequests.id, events.requestId))
        .where(
          and(
            inArray(events.type, alertTypes),
            inArray(reviewRequests.projectId, projectIds)
          )
        )
        .orderBy(desc(events.id))
        .limit(15)
    : [];

  const shellData: ShellData = {
    workspace: { name: workspace?.name ?? 'Workspace', href: '/admin' },
    projects: projectRows.map((p) => ({
      slug: p.slug,
      name: p.name,
      href: `/admin/projects/${p.slug}`,
      // Distinct slugs, in the order the resolver would see them. A queue slug
      // exists in both environments; the crumb switches slug, not environment.
      queueSlugs: [
        ...new Set(queueRows.filter((q) => q.projectId === p.id).map((q) => q.slug)),
      ],
    })),
    alerts: alertRows.map(({ event, request }) => ({
      id: String(event.id),
      text:
        event.type === 'correction.persisting'
          ? `Model ignored ${(event.payload as any).count} correction(s) on “${request.title}”`
          : event.type === 'decision.escalated'
            ? `Escalation on “${request.title}” — needs a ruling`
            : event.type === 'request.budget_exhausted'
              ? `Last round used on “${request.title}”. An operator must review it.`
              : `SLA timeout on “${request.title}” (${(event.payload as any).mode})`,
      kind:
        event.type === 'correction.persisting'
          ? 'persisting'
          : event.type === 'decision.escalated'
            ? 'escalation'
            : event.type === 'request.budget_exhausted'
              ? 'budget'
              : 'sla',
      at: event.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    })),
  };

  return (
    <Suspense>
      <AppShell data={shellData}>{children}</AppShell>
    </Suspense>
  );
}
