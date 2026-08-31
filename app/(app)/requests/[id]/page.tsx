import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import { reviewRequests, artifactVersions } from '@/lib/db/schema';
import { workspaceOfRequestOrNull, canReview } from '@/lib/core/authz';
import { NoAccess } from '@/components/shell/NoAccess';
import { getVerifiedChain } from '@/lib/core/eventlog';

export const dynamic = 'force-dynamic';

/**
 * Request Timeline & Audit Trail — read-only ledger grouped by round:
 * versions (hash), annotations, verdicts, signed events; chain-verification
 * indicator; accepted==shipped seal. SLA auto-decisions render loudly.
 */
export default async function TimelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser();
  if (!user) redirect('/auth');
  const request = await db.query.reviewRequests.findFirst({ where: eq(reviewRequests.id, id) });
  if (!request) notFound();
  const wsId = await workspaceOfRequestOrNull(request.id);
  if (wsId === null || !(await canReview(user.id, wsId))) return <NoAccess />;

  const { rows, verification } = await getVerifiedChain(db, request.id);
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.requestId, request.id))
    .orderBy(asc(artifactVersions.versionNumber));

  const glyph: Record<string, string> = {
    'request.created': '＋',
    'version.submitted': '⬆',
    'anchors.classified': '⚓',
    'correction.persisting': '⚑',
    'annotation.created': '✎',
    'request.claimed': '👤',
    'request.released': '↩',
    'lease.expired': '⌛',
    'decision.accepted': '✓',
    'decision.rejected': '✗',
    'decision.escalated': '▲',
    'request.budget_exhausted': '⚑',
    'anchor.repinned': '📌',
    'anchor.retired': '🗑',
    'sla.timeout': '⏰',
  };

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link href="/requests" style={{ fontSize: 13, color: 'var(--slate-600)', textDecoration: 'none' }}>
            ← Requests
          </Link>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{request.title}</span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 9999,
              padding: '1px 8px',
              background: verification.ok ? 'var(--green-100)' : 'var(--red-100)',
              color: verification.ok ? 'var(--green-900)' : 'var(--red-900)',
            }}
            title="Hash-chain verification across the full event trail"
          >
            {verification.ok ? `chain verified · ${rows.length} events` : `chain BROKEN at seq ${verification.brokenAtSeq}`}
          </span>
          {request.acceptedHash && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 9999,
                padding: '1px 8px',
                background: 'var(--green-100)',
                color: 'var(--green-900)',
                fontFamily: 'var(--font-mono)',
              }}
              title="Content hash inside the signed acceptance event — shipped is provably what was accepted"
            >
              sealed sha256:{request.acceptedHash.slice(0, 12)}…
            </span>
          )}
          <div style={{ flex: 1 }} />
          {versions.length > 1 && (
            <Link
              href={`/review/${request.id}/compare`}
              style={{ fontSize: 13, color: 'var(--blue-700)', textDecoration: 'none', fontWeight: 500 }}
            >
              Open compare
            </Link>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {versions.map((v) => (
            <span
              key={v.id}
              style={{
                fontSize: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '4px 10px',
                background: '#fff',
                fontFamily: 'var(--font-mono)',
              }}
            >
              v{v.versionNumber} · {v.humanAuthored ? 'human' : 'model'} · {v.contentHash.slice(0, 8)}
            </span>
          ))}
        </div>

        <div style={{ borderLeft: '2px solid var(--border)', marginLeft: 8, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((e) => {
            const loud = e.type === 'sla.timeout';
            const isDecision = e.type.startsWith('decision.');
            return (
              <div
                key={e.seq}
                style={{
                  background: loud ? 'var(--amber-50)' : '#fff',
                  border: loud ? '1px solid var(--amber-500)' : '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 18, textAlign: 'center' }}>{glyph[e.type] ?? '·'}</span>
                  <span style={{ fontSize: 13, fontWeight: isDecision ? 600 : 500 }}>{e.type}</span>
                  {loud && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--amber-900)' }}>
                      AUTOMATED — SLA policy decision, not a human verdict
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                    seq {e.seq} · {e.createdAt.toISOString().replace('T', ' ').slice(0, 19)}
                  </span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    fontSize: 11.5,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--slate-600)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 160,
                    overflow: 'auto',
                  }}
                >
                  {JSON.stringify(e.payload, null, 1)}
                </pre>
                <span style={{ fontSize: 10.5, color: 'var(--slate-400)', fontFamily: 'var(--font-mono)' }}>
                  {e.prevHash.slice(0, 10)}… → {e.hash.slice(0, 10)}…
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
