import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser, currentMembership } from '@/lib/db/queries';
import { canOperate } from '@/lib/core/authz';
import { resolveQueue } from '@/lib/core/queue';
import { db } from '@/lib/db/drizzle';
import { NoAccess } from '@/components/shell/NoAccess';

export const dynamic = 'force-dynamic';

/**
 * Stub. Last-round Reject already sets status escalated. Approve still closes
 * the row. The operator inbox that rules on those rows is VOBO-300.
 */
export default async function EscalationsStubPage() {
  const user = await getUser();
  if (!user) redirect('/auth');
  const membership = await currentMembership(user.id);
  if (!membership) redirect('/auth');
  if (!(await canOperate(user.id, membership.workspaceId))) {
    return <NoAccess detail="Escalated reviews are for operators and admins." />;
  }

  const resolved = await resolveQueue(db, { workspaceId: membership.workspaceId });
  const failingHref =
    resolved.project && resolved.queue
      ? `/queue/failing?project=${encodeURIComponent(resolved.project.slug)}&queue=${encodeURIComponent(resolved.queue.slug)}&env=${resolved.queue.environment}`
      : '/queue/failing';

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>Escalations</span>
        <p style={{ fontSize: 14, color: 'var(--slate-600)', lineHeight: 1.55, margin: 0 }}>
          Reviewers Reject on the last round and move on. Those requests are
          flagged as escalated. Approve still seals them. This inbox is not
          built yet.
        </p>
        <p style={{ fontSize: 14, color: 'var(--slate-600)', lineHeight: 1.55, margin: 0 }}>
          Until then, operators can open the stopgap list of last-round flags.
        </p>
        <Link
          href={failingHref}
          style={{ fontSize: 13, color: 'var(--blue-700)', fontWeight: 500, width: 'fit-content' }}
        >
          Open failing requests
        </Link>
        <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
          Follow-up: VOBO-300 Operator inbox for last-round escalated reviews.
        </span>
      </div>
    </div>
  );
}
