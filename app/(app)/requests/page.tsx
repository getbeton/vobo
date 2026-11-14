import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { projects, reviewRequests } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const statusChip: Record<string, { bg: string; fg: string }> = {
  accepted: { bg: 'var(--green-100)', fg: 'var(--green-900)' },
  rejected: { bg: 'var(--red-100)', fg: 'var(--red-900)' },
  escalated: { bg: 'var(--amber-100)', fg: 'var(--amber-900)' },
  open: { bg: 'var(--slate-100)', fg: 'var(--slate-600)' },
  claimed: { bg: 'var(--blue-100)', fg: 'var(--blue-900)' },
};

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const params = await searchParams;
  const user = await getUser();
  if (!user) redirect('/auth');
  const membership = await currentMembership(user.id);
  if (!membership) redirect('/auth');

  // VOBO-204, third copy of the defect: this page resolved one project with an
  // unordered findFirst, so every request outside it was invisible. List the
  // whole workspace, and narrow only when the reader asks.
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, membership.workspaceId))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const selected = params.project
    ? projectRows.filter((p) => p.slug === params.project)
    : projectRows;
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

  const rows = selected.length
    ? await db
        .select()
        .from(reviewRequests)
        .where(inArray(reviewRequests.projectId, selected.map((p) => p.id)))
        .orderBy(desc(reviewRequests.updatedAt))
        .limit(100)
    : [];

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Requests</span>
          {projectRows.length > 1 && (
            <div style={{ display: 'flex', gap: 6 }}>
              <Link
                href="/requests"
                style={{
                  fontSize: 12,
                  textDecoration: 'none',
                  borderRadius: 9999,
                  padding: '2px 10px',
                  border: '1px solid var(--border)',
                  background: params.project ? '#fff' : 'var(--blue-50)',
                  color: params.project ? 'var(--slate-600)' : 'var(--blue-700)',
                }}
              >
                every project
              </Link>
              {projectRows.map((p) => (
                <Link
                  key={p.id}
                  href={`/requests?project=${encodeURIComponent(p.slug)}`}
                  style={{
                    fontSize: 12,
                    textDecoration: 'none',
                    borderRadius: 9999,
                    padding: '2px 10px',
                    border: '1px solid var(--border)',
                    background: params.project === p.slug ? 'var(--blue-50)' : '#fff',
                    color: params.project === p.slug ? 'var(--blue-700)' : 'var(--slate-600)',
                  }}
                >
                  {p.name}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => {
            const c = statusChip[r.status] ?? statusChip.open;
            return (
              <Link
                key={r.id}
                href={`/requests/${r.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: '1px solid var(--border)',
                  background: '#fff',
                  borderRadius: 10,
                  padding: '12px 16px',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 9999,
                    padding: '1px 8px',
                    background: c.bg,
                    color: c.fg,
                  }}
                >
                  {r.status}
                </span>
                <span style={{ fontWeight: 500, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.title}
                </span>
                {projectRows.length > 1 && (
                  <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                    {projectName.get(r.projectId)}
                  </span>
                )}
                <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>round {r.round}</span>
                <span style={{ fontSize: 12, color: 'var(--slate-400)', fontFamily: 'var(--font-mono)' }}>
                  {r.customerRequestId}
                </span>
              </Link>
            );
          })}
          {rows.length === 0 && (
            <div
              style={{
                border: '1px dashed var(--border)',
                borderRadius: 12,
                padding: 48,
                textAlign: 'center',
                background: '#fff',
                color: 'var(--slate-500)',
                fontSize: 13,
              }}
            >
              {params.project
                ? `No requests in ${params.project} yet — the pipeline creates them via the API.`
                : 'No requests yet — the pipeline creates them via the API.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
