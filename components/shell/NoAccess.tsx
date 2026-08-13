import Link from 'next/link';

/**
 * A workspace-scoped page reached by someone outside that workspace. This is a
 * refusal, not a fault: it must say so plainly rather than surfacing as a
 * server exception, which is what an uncaught authorization error looks like to
 * a user.
 */
export function NoAccess({ detail }: { detail?: string }) {
  return (
    <div style={{ padding: '64px 32px' }}>
      <div
        style={{
          maxWidth: 460,
          margin: '0 auto',
          background: '#fff',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 28,
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 600 }}>You do not have access to this</span>
        <span style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.6 }}>
          {detail ??
            'It belongs to a workspace you are not a member of. Ask an admin there to invite you — invitations are matched on your email address.'}
        </span>
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <Link
            href="/queue"
            style={{
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 8,
              padding: '8px 14px',
              background: 'var(--blue-600)',
              color: '#fff',
              textDecoration: 'none',
            }}
          >
            Go to your queue
          </Link>
        </div>
      </div>
    </div>
  );
}
