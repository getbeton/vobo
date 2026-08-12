import { redirect } from 'next/navigation';
import { desc, eq, inArray } from 'drizzle-orm';
import { Suspense } from 'react';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import {
  workspaceMembers,
  workspaces,
  projects,
  queues,
  events,
  reviewRequests,
} from '@/lib/db/schema';
import { AppShell, ShellData } from '@/components/shell/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect('/sign-in');

  const membership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, user.id),
  });
  if (!membership) redirect('/sign-in');

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, membership.workspaceId),
  });
  const project = await db.query.projects.findFirst({
    where: eq(projects.workspaceId, membership.workspaceId),
  });
  const queueRows = project
    ? await db.select().from(queues).where(eq(queues.projectId, project.id))
    : [];

  // Operator alert feed: recent load-bearing events across the project.
  const alertTypes = ['decision.escalated', 'correction.persisting', 'sla.timeout'];
  const alertRows = project
    ? await db
        .select({ event: events, request: reviewRequests })
        .from(events)
        .innerJoin(reviewRequests, eq(reviewRequests.id, events.requestId))
        .where(inArray(events.type, alertTypes))
        .orderBy(desc(events.id))
        .limit(15)
    : [];

  const slugs = [...new Set(queueRows.map((q) => q.slug))];
  const shellData: ShellData = {
    workspace: { name: workspace?.name ?? 'Workspace', href: '/admin' },
    project: {
      name: project?.name ?? 'Project',
      href: project ? `/admin/projects/${project.slug}` : '/admin',
    },
    queues: slugs.map((slug) => ({
      label: slug,
      value: `/queue?queue=${encodeURIComponent(slug)}`,
      href: `/queue?queue=${encodeURIComponent(slug)}`,
      selected: true,
    })),
    environments: [
      { label: 'production', value: '/queue?env=production', selected: true },
      { label: 'test', value: '/queue?env=test' },
    ],
    alerts: alertRows.map(({ event, request }) => ({
      id: String(event.id),
      text:
        event.type === 'correction.persisting'
          ? `Model ignored ${(event.payload as any).count} correction(s) on “${request.title}”`
          : event.type === 'decision.escalated'
            ? `Escalation on “${request.title}” — needs a ruling`
            : `SLA timeout on “${request.title}” (${(event.payload as any).mode})`,
      kind:
        event.type === 'correction.persisting'
          ? 'persisting'
          : event.type === 'decision.escalated'
            ? 'escalation'
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
