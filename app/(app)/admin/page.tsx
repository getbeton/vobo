import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import {
  workspaces,
  workspaceMembers,
  user as userTable,
  projects,
  queues,
  reviewRequests,
  decisions,
} from '@/lib/db/schema';
import { computeMetrics, statStrip } from '@/lib/core/metrics';
import { workspaceDefaultsSchema, DEFAULT_POLICY } from '@/lib/core/policy';
import {
  setWorkspaceDefaultsAction,
  setMemberRoleAction,
  removeMemberAction,
  inviteMemberAction,
} from '@/lib/actions/admin';
import { StatStrip, SettingRow, MembersCard } from '@/components/admin/EntityBits';

export const dynamic = 'force-dynamic';

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  boxShadow: 'var(--shadow-sm)',
};

function initials(name: string, email: string) {
  const src = name?.trim() || email.split('@')[0].replace(/[._-]+/g, ' ');
  return src
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Workspace page — verbatim port of the prototype's `wsHome` screen: stat
 * strip, projects list, members card, plan & usage, workspace policy defaults.
 */
export default async function WorkspacePage() {
  const me = await getUser();
  if (!me) redirect('/auth');
  const membership = await currentMembership(me.id);
  if (!membership) redirect('/auth');
  const ws = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, membership.workspaceId),
  });
  if (!ws) redirect('/auth');

  const isOperator = membership.role === 'operator' || membership.role === 'admin';
  const isAdmin = membership.role === 'admin';

  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, ws.id));
  const projectIds = projectRows.map((p) => p.id);

  const requests = projectIds.length
    ? await db
        .select({
          projectId: reviewRequests.projectId,
          status: reviewRequests.status,
          round: reviewRequests.round,
        })
        .from(reviewRequests)
        .where(inArray(reviewRequests.projectId, projectIds))
    : [];
  const queueRows = projectIds.length
    ? await db
        .select({ id: queues.id, projectId: queues.projectId, slug: queues.slug })
        .from(queues)
        .where(inArray(queues.projectId, projectIds))
    : [];

  const metrics = computeMetrics(requests);

  const memberRows = await db
    .select({ m: workspaceMembers, u: userTable })
    .from(workspaceMembers)
    .innerJoin(userTable, eq(userTable.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, ws.id));

  // Usage: decisions shipped in the current calendar month.
  const cycleStart = new Date();
  cycleStart.setUTCDate(1);
  cycleStart.setUTCHours(0, 0, 0, 0);
  const used = projectIds.length
    ? (
        await db
          .select({ id: decisions.id })
          .from(decisions)
          .innerJoin(reviewRequests, eq(reviewRequests.id, decisions.requestId))
          .where(
            and(
              inArray(reviewRequests.projectId, projectIds),
              gte(decisions.createdAt, cycleStart)
            )
          )
      ).length
    : 0;
  const cap = Number(process.env.VOBO_PLAN_CAP ?? '') || 0;
  const tier = process.env.VOBO_PLAN_TIER ?? 'Self-hosted';
  const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;

  const defaults = workspaceDefaultsSchema.parse(ws.policyDefaults ?? {});
  const budget = defaults.roundBudget ?? DEFAULT_POLICY.roundBudget;
  const blindN = defaults.blindN ?? DEFAULT_POLICY.blindN;
  const slaMinutes = defaults.slaMinutes ?? DEFAULT_POLICY.slaMinutes;
  const slaLabel =
    slaMinutes === null || slaMinutes === undefined
      ? 'no SLA'
      : slaMinutes % 60 === 0
        ? `${slaMinutes / 60}h · ${defaults.slaFailMode ?? DEFAULT_POLICY.slaFailMode}`
        : `${slaMinutes}m · ${defaults.slaFailMode ?? DEFAULT_POLICY.slaFailMode}`;

  const applyDefaults = setWorkspaceDefaultsAction.bind(null, ws.id);

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{ws.name}</span>
          <span
            style={{
              fontSize: 12,
              color: 'var(--slate-500)',
              background: 'var(--slate-100)',
              borderRadius: 9999,
              padding: '2px 10px',
            }}
          >
            workspace
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
            You are {membership.role} here
            {isOperator ? '' : ' — settings are read-only'}
          </span>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {isOperator && (
              <Link
                href="/admin/escalations"
                style={{
                  ...card,
                  textDecoration: 'none',
                  color: 'inherit',
                  borderColor: 'var(--amber-500)',
                  background: 'var(--amber-50)',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 14 }}>Escalations</span>
                <span style={{ fontSize: 13, color: 'var(--slate-600)' }}>
                  Last-round Reject flags a request and the reviewer moves on.
                  The operator inbox is not built yet (VOBO-300).
                </span>
              </Link>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--slate-500)',
                  textTransform: 'uppercase',
                  letterSpacing: '.04em',
                }}
              >
                Projects
              </span>
              {projectRows.map((p) => {
                const rows = requests.filter((r) => r.projectId === p.id);
                const m = computeMetrics(rows);
                const qCount = new Set(
                  queueRows.filter((q) => q.projectId === p.id).map((q) => q.slug)
                ).size;
                return (
                  <Link
                    key={p.id}
                    href={`/admin/projects/${p.slug}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
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
                      <span style={{ fontWeight: 500 }}>{p.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                        {qCount === 0
                          ? 'no queues yet — connect a pipeline'
                          : `${qCount} ${qCount === 1 ? 'queue' : 'queues'} · ${m.open} open`}
                      </span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>yield {m.fpy}</span>
                    <span style={{ color: 'var(--slate-300)' }}>›</span>
                  </Link>
                );
              })}
              {projectRows.length === 0 && (
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
                  No projects in this workspace yet.
                </div>
              )}
            </div>

            <MembersCard
              workspaceId={ws.id}
              canEdit={isAdmin}
              note={`${memberRows.length} ${memberRows.length === 1 ? 'member' : 'members'} · roles apply across every project`}
              members={memberRows.map(({ m, u }) => ({
                id: m.id,
                init: initials(u.name, u.email),
                name: u.name || u.email.split('@')[0],
                email: u.email,
                role: m.role,
                self: u.id === me.id,
              }))}
              setRole={setMemberRoleAction as never}
              remove={removeMemberAction as never}
              invite={inviteMemberAction as never}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Plan &amp; usage</span>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--blue-700)',
                    background: 'var(--blue-50)',
                    borderRadius: 9999,
                    padding: '1px 10px',
                    fontWeight: 500,
                  }}
                >
                  {tier}
                </span>
              </div>
              <span style={{ fontSize: 13, color: 'var(--slate-700)' }}>
                {cap ? `${used} / ${cap} reviews this cycle` : `${used} reviews this cycle`}
                {cap ? <span style={{ color: 'var(--slate-400)' }}> · {pct}%</span> : null}
              </span>
              {cap > 0 && (
                <div
                  style={{
                    height: 8,
                    borderRadius: 9999,
                    background: 'var(--slate-100)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: pct > 90 ? 'var(--red-500)' : 'var(--blue-600)',
                    }}
                  />
                </div>
              )}
              <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                Counted from shipped decisions since {cycleStart.toISOString().slice(0, 10)}.
              </span>
            </div>

            <div style={card}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Workspace defaults</span>
              <SettingRow
                label="SLA policy"
                value={slaLabel}
                canEdit={isOperator}
                apply={applyDefaults}
                width={220}
                items={[
                  { label: 'no SLA', selected: slaMinutes == null, patch: { slaMinutes: null } },
                  { label: '1h · fail closed', selected: slaMinutes === 60, patch: { slaMinutes: 60, slaFailMode: 'fail_closed' } },
                  { label: '4h · fail closed', selected: slaMinutes === 240, patch: { slaMinutes: 240, slaFailMode: 'fail_closed' } },
                  { label: '24h · fail closed', selected: slaMinutes === 1440, patch: { slaMinutes: 1440, slaFailMode: 'fail_closed' } },
                ]}
              />
              <SettingRow
                label="Round budget"
                value={`${budget} rounds`}
                canEdit={isOperator}
                apply={applyDefaults}
                items={[2, 3, 4].map((n) => ({
                  label: `${n} rounds`,
                  selected: budget === n,
                  patch: { roundBudget: n },
                }))}
              />
              <SettingRow
                label="Blind-N review"
                value={blindN ? `blind-${blindN} by default` : 'off by default'}
                canEdit={isOperator}
                apply={applyDefaults}
                items={[
                  { label: 'off by default', selected: !blindN, patch: { blindN: 0 } },
                  { label: 'blind-2 by default', selected: blindN === 2, patch: { blindN: 2 } },
                ]}
              />
              <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                Projects inherit these; queues can override on their own page. Changing a default
                publishes a new policy version for every inheriting queue — in-flight requests keep
                the version they were stamped with.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
