import Link from 'next/link';
import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser, currentMembership } from '@/lib/db/queries';
import { workspaceMembers, projects, reviewRequests } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const statusChip: Record<string, { bg: string; fg: string }> = {
  accepted: { bg: 'var(--green-100)', fg: 'var(--green-900)' },
  rejected: { bg: 'var(--red-100)', fg: 'var(--red-900)' },
  escalated: { bg: 'var(--amber-100)', fg: 'var(--amber-900)' },
  open: { bg: 'var(--slate-100)', fg: 'var(--slate-600)' },
  claimed: { bg: 'var(--blue-100)', fg: 'var(--blue-900)' },
};

export default async function RequestsPage() {
  const user = await getUser();
  if (!user) redirect('/sign-in');
  const membership = await currentMembership(user.id);
  if (!membership) redirect('/sign-in');
  const project = await db.query.projects.findFirst({
    where: eq(projects.workspaceId, membership.workspaceId),
  });
  const rows = project
    ? await db
        .select()
        .from(reviewRequests)
        .where(eq(reviewRequests.projectId, project.id))
        .orderBy(desc(reviewRequests.updatedAt))
        .limit(100)
    : [];

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>Requests</span>
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
              No requests yet — the pipeline creates them via the API.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
