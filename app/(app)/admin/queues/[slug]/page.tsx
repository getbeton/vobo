import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import {
  workspaces,
  workspaceMembers,
  projects,
  queues,
  criteria,
  reviewRequests,
} from '@/lib/db/schema';
import { computeMetrics } from '@/lib/core/metrics';
import { workspaceDefaultsSchema, DEFAULT_POLICY } from '@/lib/core/policy';
import { resolveQueuePolicy } from '@/lib/core/policy-store';
import { setQueueSlugOverrideAction } from '@/lib/actions/admin';
import { SettingRow } from '@/components/admin/EntityBits';

export const dynamic = 'force-dynamic';

/**
 * Queue page — verbatim port of the prototype's `qHome` screen: one card per
 * environment with its open count and a jump into the reviewer queue, plus the
 * queue policy card (criteria of the active version, inherit-vs-override rows,
 * sticky regenerations).
 */
export default async function QueueAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const me = await getUser();
  if (!me) redirect('/sign-in');
  const membership = await currentMembership(me.id);
  if (!membership) redirect('/sign-in');
  const isOperator = membership.role === 'operator' || membership.role === 'admin';

  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, membership.workspaceId));
  const project = sp.project
    ? projectRows.find((p) => p.slug === sp.project)
    : projectRows[0];
  if (!project) notFound();

  const envRows = await db
    .select()
    .from(queues)
    .where(and(eq(queues.projectId, project.id), eq(queues.slug, slug)))
    .orderBy(asc(queues.environment));
  if (envRows.length === 0) notFound();

  const production = envRows.find((q) => q.environment === 'production') ?? envRows[0];
  const requests = await db
    .select({
      queueId: reviewRequests.queueId,
      status: reviewRequests.status,
      round: reviewRequests.round,
    })
    .from(reviewRequests)
    .where(inArray(reviewRequests.queueId, envRows.map((q) => q.id)));

  const resolved = await resolveQueuePolicy(db, production.id);
  const crits = await db
    .select()
    .from(criteria)
    .where(and(eq(criteria.queueId, production.id), isNull(criteria.archivedAt)))
    .orderBy(asc(criteria.position));

  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, membership.workspaceId),
  });
  const defaults = workspaceDefaultsSchema.parse(ws?.policyDefaults ?? {});
  const wsBudget = defaults.roundBudget ?? DEFAULT_POLICY.roundBudget;
  const wsBlind = defaults.blindN ?? DEFAULT_POLICY.blindN;
  const overrides = (production.policyOverrides ?? {}) as Record<string, unknown>;
  const hasBudgetOverride = 'roundBudget' in overrides;
  const hasBlindOverride = 'blindN' in overrides;

  const apply = setQueueSlugOverrideAction.bind(null, project.id, slug);

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link
            href={`/admin/projects/${project.slug}`}
            style={{ fontSize: 13, color: 'var(--slate-600)', textDecoration: 'none' }}
          >
            ← {project.name}
          </Link>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{production.name}</span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--slate-500)',
              background: 'var(--slate-100)',
              borderRadius: 9999,
              padding: '2px 10px',
            }}
          >
            queue
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>You are {membership.role} here</span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) 340px',
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
              Environments
            </span>
            {envRows.map((q) => {
              const m = computeMetrics(requests.filter((r) => r.queueId === q.id));
              const isProd = q.environment === 'production';
              return (
                <div
                  key={q.id}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        background: isProd ? 'var(--green-100)' : 'var(--slate-100)',
                        color: isProd ? 'var(--green-900)' : 'var(--slate-600)',
                        borderRadius: 9999,
                        padding: '2px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {q.environment}
                    </span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                      {m.decided} decided
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 600 }}>{m.open}</span>
                    <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>open for review</span>
                  </div>
                  <div style={{ display: 'flex' }}>
                    <Link
                      href={`/queue?queue=${encodeURIComponent(q.slug)}&env=${q.environment}`}
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        borderRadius: 8,
                        padding: '8px 14px',
                        textDecoration: 'none',
                        border: isProd ? 'none' : '1px solid var(--border)',
                        background: isProd ? 'var(--blue-600)' : '#fff',
                        color: isProd ? '#fff' : 'var(--slate-700)',
                      }}
                    >
                      Open reviewer queue
                    </Link>
                  </div>
                </div>
              );
            })}
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
            <span style={{ fontSize: 13, fontWeight: 600 }}>Queue policy</span>
            <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
              Criteria — policy v{resolved.version}
            </span>
            {crits.map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  borderTop: '1px solid var(--slate-100)',
                  paddingTop: 8,
                }}
              >
                <span style={{ color: 'var(--slate-300)', fontSize: 11 }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span style={{ fontSize: 13, color: 'var(--slate-700)', flex: 1 }}>{c.title}</span>
              </div>
            ))}

            <SettingRow
              label="Round budget"
              value={
                hasBudgetOverride
                  ? `${resolved.config.roundBudget} rounds · override`
                  : `inherit — ${wsBudget} rounds`
              }
              canEdit={isOperator}
              apply={apply}
              width={230}
              items={[
                {
                  label: `Inherit workspace default (${wsBudget})`,
                  selected: !hasBudgetOverride,
                  patch: { roundBudget: null },
                },
                ...[2, 3, 4].map((n) => ({
                  label: `${n} rounds`,
                  selected: hasBudgetOverride && resolved.config.roundBudget === n,
                  patch: { roundBudget: n },
                })),
              ]}
            />
            <SettingRow
              label="Blind-N review"
              value={
                hasBlindOverride
                  ? resolved.config.blindN
                    ? `blind-${resolved.config.blindN} · override`
                    : 'off · override'
                  : `inherit — ${wsBlind ? `blind-${wsBlind}` : 'off'}`
              }
              canEdit={isOperator}
              apply={apply}
              width={230}
              items={[
                {
                  label: `Inherit (${wsBlind ? `blind-${wsBlind}` : 'off'})`,
                  selected: !hasBlindOverride,
                  patch: { blindN: null },
                },
                { label: 'off', selected: hasBlindOverride && !resolved.config.blindN, patch: { blindN: 0 } },
                { label: 'blind-2', selected: resolved.config.blindN === 2 && hasBlindOverride, patch: { blindN: 2 } },
              ]}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderTop: '1px solid var(--slate-100)',
                paddingTop: 10,
              }}
            >
              <span style={{ flex: 1, fontSize: 13, color: 'var(--slate-700)' }}>
                Sticky regenerations
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: resolved.config.stickyRegenerations ? 'var(--green-900)' : 'var(--slate-600)',
                  background: resolved.config.stickyRegenerations ? 'var(--green-100)' : 'var(--slate-100)',
                  borderRadius: 9999,
                  padding: '2px 10px',
                  fontWeight: 500,
                }}
              >
                {resolved.config.stickyRegenerations
                  ? 'on — returns to the same reviewer'
                  : 'off — back to the open pool'}
              </span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
              {isOperator
                ? 'Overrides apply to new rounds in both environments — each change publishes a new policy version.'
                : 'Read-only — an operator can override the round budget and blind-N here.'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
