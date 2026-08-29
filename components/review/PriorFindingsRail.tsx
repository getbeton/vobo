'use client';

import type { Ref } from 'react';
import { artifactStateColors } from './ArtifactPane';

/**
 * Prior-findings cards: Resolved C · Persists P · Re-pin O · Retire X.
 * Workspace rail: Resolved C · Persists P · Re-pin O · Retire X, so C then
 * Approve is not hidden on another screen.
 */

export interface FindingData {
  id: string;
  body: string;
  expected: string | null;
  quote: string;
  startPos: number;
  endPos: number;
  bornRound: number;
  resolvedComment: boolean;
  state: string | null;
  confidence: string | null;
  confirmation: string | null;
  landing: { start: number; end: number; quote: string } | null;
}

export function PriorFindingsList({
  items,
  focusId,
  onFocus,
  retireFor,
  retireReason,
  onRetireReasonChange,
  reasonRef,
  onResolved,
  onPersists,
  onOpenRepin,
  onOpenRetire,
  onCommitRetire,
  onCancelFollowUp,
  emptyLabel,
}: {
  items: FindingData[];
  focusId: string | null;
  onFocus: (id: string) => void;
  retireFor: string | null;
  retireReason: string;
  onRetireReasonChange: (value: string) => void;
  reasonRef: Ref<HTMLInputElement>;
  onResolved: (id: string) => void;
  onPersists: (id: string) => void;
  onOpenRepin: (id: string) => void;
  onOpenRetire: (id: string) => void;
  onCommitRetire: () => void;
  onCancelFollowUp: () => void;
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    if (!emptyLabel) return null;
    return <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>{emptyLabel}</span>;
  }

  return (
    <>
      {items.map((f) => (
        <div
          key={f.id}
          onClick={() => onFocus(f.id)}
          style={{
            border: f.id === focusId ? '1px solid var(--blue-400)' : '1px solid var(--border)',
            borderRadius: 8,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {stateChip(f)}
            <span
              style={{
                fontSize: 11,
                color: 'var(--slate-500)',
                flex: 1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              “{f.quote.slice(0, 36)}”
            </span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{f.body}</span>
          {f.expected && (
            <span style={{ fontSize: 12, color: 'var(--slate-500)', lineHeight: 1.5 }}>
              Expected: {f.expected}
            </span>
          )}
          {retireFor === f.id ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                ref={reasonRef}
                autoFocus
                value={retireReason}
                onChange={(e) => onRetireReasonChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancelFollowUp();
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCommitRetire();
                  }
                }}
                placeholder="Retire reason — required"
                style={{
                  flex: 1,
                  border: '1px solid var(--input)',
                  borderRadius: 6,
                  padding: '6px 9px',
                  fontSize: 12.5,
                  outline: 'none',
                }}
              />
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm"
                disabled={retireReason.trim().length < 2}
                onClick={onCommitRetire}
              >
                Retire
              </button>
            </div>
          ) : f.confirmation === 'res' || f.resolvedComment ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--sm"
                style={{ height: 28, fontSize: 12 }}
                onClick={() => onOpenRetire(f.id)}
                title="Drop from history — not required for Approve"
              >
                Retire <kbd style={{ fontSize: 10 }}>X</kbd>
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm"
                style={{ height: 28, fontSize: 12 }}
                onClick={() => onResolved(f.id)}
              >
                Resolved <kbd style={{ fontSize: 10 }}>C</kbd>
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm"
                style={{ height: 28, fontSize: 12 }}
                onClick={() => onPersists(f.id)}
              >
                Persists <kbd style={{ fontSize: 10 }}>P</kbd>
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--outline ds-btn--sm"
                style={{ height: 28, fontSize: 12 }}
                onClick={() => onOpenRepin(f.id)}
              >
                Re-pin <kbd style={{ fontSize: 10 }}>O</kbd>
              </button>
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--sm"
                style={{ height: 28, fontSize: 12 }}
                onClick={() => onOpenRetire(f.id)}
              >
                Retire <kbd style={{ fontSize: 10 }}>X</kbd>
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function stateChip(f: FindingData) {
  const displayState =
    f.confirmation === 'res' || f.resolvedComment
      ? 'resolved'
      : f.confirmation === 'per'
        ? 'persisting'
        : f.state ?? 'new';
  const c = artifactStateColors[displayState] ?? artifactStateColors.new;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 9999,
        padding: '1px 9px',
        background: c.bg,
        color: c.fg,
      }}
    >
      {displayState}
      {f.confidence && f.confirmation === null && f.state !== 'new' ? ` · ${f.confidence}` : ''}
      {f.confirmation === 'per' ? ' · re-asserted' : ''}
    </span>
  );
}
