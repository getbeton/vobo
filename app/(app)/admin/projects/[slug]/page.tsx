import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import {
  workspaces,
  workspaceMembers,
  projects,
  queues,
  reviewRequests,
} from '@/lib/db/schema';
import { computeMetrics, statStrip } from '@/lib/core/metrics';
import { workspaceDefaultsSchema, DEFAULT_POLICY } from '@/lib/core/policy';
import { StatStrip } from '@/components/admin/EntityBits';

export const dynamic = 'force-dynamic';

/**
 * Project page — verbatim port of the prototype's `projHome` screen: stat
 * strip, queue list (one row per queue slug, both environments folded in), and
 * a read-only policy-defaults card ("edit on the workspace page").
 */
export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const me = await getUser();
  if (!me) redirect('/sign-in');
  const membership = await currentMembership(me.id);
  if (!membership) redirect('/sign-in');

  const project = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, membership.workspaceId), eq(projects.slug, slug)),
  });
  if (!project) notFound();
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, membership.workspaceId),
  });

  const queueRows = await db.select().from(queues).where(eq(queues.projectId, project.id));
  const requests = await db
    .select({
      queueId: reviewRequests.queueId,
      status: reviewRequests.status,
      round: reviewRequests.round,
    })
    .from(reviewRequests)
    .where(eq(reviewRequests.projectId, project.id));

  const metrics = computeMetrics(requests);

  const bySlug = new Map<string, { name: string; ids: string[]; envs: string[] }>();
  for (const q of queueRows) {
    const entry = bySlug.get(q.slug) ?? { name: q.name, ids: [], envs: [] };
    entry.ids.push(q.id);
    entry.envs.push(q.environment);
    bySlug.set(q.slug, entry);
  }
  const overrideCount = queueRows.filter(
    (q) => Object.keys((q.policyOverrides ?? {}) as object).length > 0
  ).length;

  const defaults = workspaceDefaultsSchema.parse(ws?.policyDefaults ?? {});
  const budget = defaults.roundBudget ?? DEFAULT_POLICY.roundBudget;
  const blindN = defaults.blindN ?? DEFAULT_POLICY.blindN;
  const sla = defaults.slaMinutes ?? DEFAULT_POLICY.slaMinutes;

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <Link href="/admin" style={{ fontSize: 13, color: 'var(--slate-600)', textDecoration: 'none' }}>
            ← {ws?.name ?? 'Workspace'}
          </Link>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{project.name}</span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--slate-500)',
              background: 'var(--slate-100)',
              borderRadius: 9999,
              padding: '2px 10px',
            }}
          >
            project
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>You are {membership.role} here</span>
        </div>

        <StatStrip
          stats={statStrip(metrics)}
          note={
            metrics.accepted === 0
              ? 'No accepted units yet — yield, rounds, and cost fill in live as you review.'
              : null
          }
        />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) 320px',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--slate-500)',
                textTransform: 'uppercase',
                letterSpacing: '.04em',
              }}
            >
              Queues
            </span>
            {[...bySlug.entries()].map(([qSlug, entry]) => {
              const rows = requests.filter((r) => entry.ids.includes(r.queueId));
              const m = computeMetrics(rows);
              return (
                <Link
                  key={qSlug}
                  href={`/admin/queues/${qSlug}?project=${project.slug}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: '#fff',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '14px 16px',
                    boxShadow: 'var(--shadow-sm)',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 500 }}>{entry.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                      {m.open} open · {m.decided} decided ·{' '}
                      {entry.envs.includes('production') && entry.envs.includes('test')
                        ? 'prod + test'
                        : entry.envs.join(' + ')}
                    </span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>yield {m.fpy}</span>
                  <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>rounds {m.rta}</span>
                  <span style={{ color: 'var(--slate-300)' }}>›</span>
                </Link>
              );
            })}
            {bySlug.size === 0 && (
              <div
                style={{
                  border: '1px dashed var(--border)',
                  borderRadius: 10,
                  padding: 24,
                  fontSize: 13,
                  color: 'var(--slate-400)',
                  background: '#fff',
                  textAlign: 'center',
                }}
              >
                No queues in this project yet — the pipeline hasn’t registered any.
              </div>
            )}
          </div>

          <div
            style={{
              background: '#fff',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Policy defaults</span>
            <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
              {bySlug.size === 0
                ? 'Nothing to inherit yet.'
                : `${bySlug.size} ${bySlug.size === 1 ? 'queue' : 'queues'} inherit · ${overrideCount} ${
                    overrideCount === 1 ? 'override' : 'overrides'
                  }`}
            </span>
            {[
              { l: 'SLA policy', v: sla == null ? 'no SLA' : `${sla}m · ${defaults.slaFailMode ?? DEFAULT_POLICY.slaFailMode}` },
              { l: 'Round budget', v: `${budget} rounds` },
              { l: 'Blind-N review', v: blindN ? `blind-${blindN}` : 'off' },
            ].map((d) => (
              <div
                key={d.l}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderTop: '1px solid var(--slate-100)',
                  paddingTop: 10,
                }}
              >
                <span style={{ flex: 1, fontSize: 13, color: 'var(--slate-700)' }}>{d.l}</span>
                <span style={{ fontSize: 12, color: 'var(--slate-600)' }}>{d.v}</span>
              </div>
            ))}
            <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
              Edit defaults on the workspace page; override per queue on each queue page.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
