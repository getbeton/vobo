'use client';

export interface SuggestionData {
  id: string;
  startPos: number;
  endPos: number;
  originalQuote: string;
  replacement: string;
  status: 'pending' | 'applied' | 'rejected';
}

export function SuggestionList({
  items,
  onAccept,
  onReject,
}: {
  items: SuggestionData[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const visible = items.filter((s) => s.status !== 'rejected');
  if (visible.length === 0) return null;
  return (
    <>
      {visible.map((s) => (
        <div
          key={s.id}
          data-testid={`suggestion-${s.id}`}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 9999,
              padding: '1px 9px',
              alignSelf: 'flex-start',
              background: s.status === 'applied' ? 'var(--green-100)' : 'var(--amber-100)',
              color: s.status === 'applied' ? 'var(--green-900)' : 'var(--amber-900)',
            }}
          >
            {s.status === 'applied' ? 'applied' : 'pending'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
            “{s.originalQuote.slice(0, 40)}”
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>
            {s.replacement.length > 0 ? s.replacement : '(delete)'}
          </span>
          {s.status === 'pending' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm"
                onClick={() => onAccept(s.id)}
              >
                Accept
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--sm"
                onClick={() => onReject(s.id)}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
