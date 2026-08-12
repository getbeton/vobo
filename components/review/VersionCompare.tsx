'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  confirmResolutionAction,
  markPersistingAction,
  repinAction,
  retireAction,
  shipAction,
  gateAction,
} from '@/lib/actions/review';

/**
 * Version Compare — the moat screen, verbatim from the prototype:
 * v(n−1) left / v(n) right with selectors on BOTH panes (original anchor on
 * the left, ghosted landing or margin orphan marker on the right, dashed at
 * low confidence), synchronized scroll, version log rail (any-vs-any,
 * default latest-vs-last-verdicted), prior-findings rail "verify against
 * intent" with Resolved C · Persists P · Re-pin O · Retire X (reason),
 * round-budget banner → escalate, decision bar with server gates.
 */

interface VersionInfo {
  number: number;
  content: string;
  author: string;
  hash: string;
  id?: string;
}

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

const stateColors: Record<string, { bg: string; fg: string; border: string }> = {
  persisting: { bg: 'var(--red-100)', fg: 'var(--red-900)', border: 'var(--red-500)' },
  resolved: { bg: 'var(--green-100)', fg: 'var(--green-900)', border: 'var(--green-500)' },
  orphaned: { bg: 'var(--amber-100)', fg: 'var(--amber-900)', border: 'var(--amber-500)' },
  repinned: { bg: 'var(--blue-100)', fg: 'var(--blue-900)', border: 'var(--blue-500)' },
  new: { bg: 'var(--blue-100)', fg: 'var(--blue-900)', border: 'var(--blue-500)' },
};

function renderPane(
  content: string,
  marks: Array<{ start: number; end: number; state: string; low: boolean; focused: boolean }>,
  refCb?: (el: HTMLDivElement | null) => void,
  onMouseUp?: () => void,
  dataSide?: string
) {
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  const segs: Array<{ text: string; start: number; mark: (typeof marks)[number] | null }> = [];
  let pos = 0;
  for (const m of sorted) {
    if (m.start < pos || m.start >= content.length) continue;
    if (m.start > pos) segs.push({ text: content.slice(pos, m.start), start: pos, mark: null });
    const end = Math.min(m.end, content.length);
    segs.push({ text: content.slice(m.start, end), start: m.start, mark: m });
    pos = end;
  }
  if (pos < content.length) segs.push({ text: content.slice(pos), start: pos, mark: null });

  return (
    <div
      ref={refCb}
      onMouseUp={onMouseUp}
      data-side={dataSide}
      style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '24px 28px 80px' }}
    >
      <div style={{ fontSize: 14.5, lineHeight: 1.8, color: 'var(--slate-800)', whiteSpace: 'pre-wrap', maxWidth: 700 }}>
        {segs.map((s) => {
          if (!s.mark)
            return (
              <span key={s.start} data-seg-start={s.start}>
                {s.text}
              </span>
            );
          const c = stateColors[s.mark.state] ?? stateColors.new;
          return (
            <span
              key={s.start}
              data-seg-start={s.start}
              style={{
                background: c.bg,
                borderBottom: `2px ${s.mark.low ? 'dashed' : 'solid'} ${c.border}`,
                outline: s.mark.focused ? `2px solid ${c.border}` : undefined,
              }}
            >
              {s.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function VersionCompare({
  request,
  left,
  right,
  versions,
  findings,
  criteriaScored,
  unscoredCount,
}: {
  request: { id: string; title: string; round: number; roundBudget: number; status: string };
  left: VersionInfo;
  right: VersionInfo;
  versions: Array<{ number: number; author: string; hash: string; human: boolean }>;
  findings: FindingData[];
  criteriaScored: boolean;
  unscoredCount: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [repinFor, setRepinFor] = useState<string | null>(null);
  const [retireFor, setRetireFor] = useState<string | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [escReason, setEscReason] = useState('');
  const [showEscalate, setShowEscalate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateInfo, setGateInfo] = useState<{ blocked: boolean; reasons: string[]; interstitials: string[] } | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const syncing = useRef(false);

  const prior = findings.filter((f) => f.bornRound < request.round);
  const ordered = useMemo(() => {
    const rank = (f: FindingData) =>
      f.state === 'persisting' ? 0 : f.state === 'orphaned' ? 1 : f.state === 'repinned' ? 2 : 3;
    return [...prior].sort((a, b) => rank(a) - rank(b));
  }, [prior]);

  const budgetReached = request.round >= request.roundBudget;

  // Synchronized scroll (ratio-based).
  useEffect(() => {
    const l = leftRef.current;
    const r = rightRef.current;
    if (!l || !r) return;
    const sync = (src: HTMLDivElement, dst: HTMLDivElement) => () => {
      if (syncing.current) return;
      syncing.current = true;
      const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
      dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
      requestAnimationFrame(() => (syncing.current = false));
    };
    const onL = sync(l, r);
    const onR = sync(r, l);
    l.addEventListener('scroll', onL);
    r.addEventListener('scroll', onR);
    return () => {
      l.removeEventListener('scroll', onL);
      r.removeEventListener('scroll', onR);
    };
  }, []);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    startTransition(async () => {
      await fn();
      router.refresh();
    });
  };

  const captureRepin = () => {
    if (!repinFor) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const pane = rightRef.current;
    if (!pane) return;
    const findAbs = (node: Node, offset: number): number | null => {
      let el: HTMLElement | null =
        node.nodeType === Node.TEXT_NODE ? (node.parentElement as HTMLElement) : (node as HTMLElement);
      while (el && el !== pane && !el.dataset?.segStart) el = el.parentElement;
      if (!el || !el.dataset?.segStart) return null;
      return Number(el.dataset.segStart) + offset;
    };
    const a = findAbs(sel.anchorNode!, sel.anchorOffset);
    const b = findAbs(sel.focusNode!, sel.focusOffset);
    if (a === null || b === null) return;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end <= start) return;
    const annotationId = repinFor;
    setRepinFor(null);
    act(() =>
      repinAction({
        requestId: request.id,
        annotationId,
        versionId: right.id!,
        newQuote: right.content.slice(start, end),
        newStartPos: start,
        newEndPos: end,
      })
    );
  };

  const openShip = () => {
    startTransition(async () => {
      const res = await gateAction(request.id);
      if (res.ok && res.data) setGateInfo(res.data as any);
    });
  };

  const ship = (kind: 'approve' | 'reject_corrections' | 'escalate', ack = false) => {
    setError(null);
    startTransition(async () => {
      const res = await shipAction({
        requestId: request.id,
        kind,
        reason: kind === 'escalate' ? escReason : undefined,
        acknowledgeInterstitials: ack,
      });
      if (res.ok) router.push('/queue');
      else setError(res.error);
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return;
      const f = ordered.find((x) => x.id === focusId) ?? ordered[0];
      if (e.key === 'Escape') setRepinFor(null);
      if (!f) return;
      if (e.key === 'j' || e.key === 'J') {
        const i = ordered.findIndex((x) => x.id === (focusId ?? f.id));
        setFocusId(ordered[Math.min(i + 1, ordered.length - 1)]?.id ?? null);
      }
      if (e.key === 'k' || e.key === 'K') {
        const i = ordered.findIndex((x) => x.id === (focusId ?? f.id));
        setFocusId(ordered[Math.max(i - 1, 0)]?.id ?? null);
      }
      if (e.key === 'c' || e.key === 'C')
        act(() => confirmResolutionAction(request.id, f.id, right.id!));
      if (e.key === 'p' || e.key === 'P')
        act(() => markPersistingAction(request.id, f.id, right.id!));
      if (e.key === 'o' || e.key === 'O') setRepinFor(f.id);
      if (e.key === 'x' || e.key === 'X') setRetireFor(f.id);
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') openShip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, focusId]);

  const leftMarks = prior.map((f) => ({
    start: f.startPos,
    end: f.endPos,
    state: f.state ?? 'new',
    low: false,
    focused: f.id === focusId,
  }));
  // Left pane shows ORIGINAL anchors; for persisting/repinned the annotation
  // selector already moved to the landing — show landing only on the right.
  const rightMarks = prior
    .filter((f) => f.landing)
    .map((f) => ({
      start: f.landing!.start,
      end: f.landing!.end,
      state: f.confirmation === 'res' ? 'resolved' : f.state ?? 'new',
      low: f.confidence === 'low',
      focused: f.id === focusId,
    }));
  const newMarks = findings
    .filter((f) => f.bornRound === request.round)
    .map((f) => ({ start: f.startPos, end: f.endPos, state: 'new', low: false, focused: f.id === focusId }));

  const orphans = prior.filter((f) => f.state === 'orphaned');

  const stateChip = (f: FindingData) => {
    const displayState = f.confirmation === 'res' ? 'resolved' : f.confirmation === 'per' ? 'persisting' : f.state ?? 'new';
    const c = stateColors[displayState] ?? stateColors.new;
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
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 24px',
          background: '#fff',
          borderBottom: '1px solid var(--border)',
          flex: 'none',
          flexWrap: 'wrap',
        }}
      >
        <Link
          href={`/review/${request.id}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            color: 'var(--slate-600)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '9px 12px',
            fontWeight: 500,
            background: '#fff',
            textDecoration: 'none',
          }}
        >
          ← Workspace
        </Link>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{request.title}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 9999,
            padding: '2px 10px',
            background: budgetReached ? 'var(--amber-100)' : 'var(--slate-100)',
            color: budgetReached ? 'var(--amber-900)' : 'var(--slate-600)',
          }}
        >
          Round {request.round} of {request.roundBudget}
        </span>
        <div style={{ flex: 1 }} />
        {/* Version log rail (any-vs-any) */}
        <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>Compare</span>
        <select
          value={left.number}
          onChange={(e) => router.push(`/review/${request.id}/compare?l=${e.target.value}&r=${right.number}`)}
          className="ds-select-trigger"
          style={{ width: 130, height: 32, fontSize: 12 }}
          title="Left version"
        >
          {versions
            .filter((v) => v.number < right.number)
            .map((v) => (
              <option key={v.number} value={v.number}>
                v{v.number} · {v.human ? 'human' : 'model'} · {v.hash}
              </option>
            ))}
        </select>
        <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>↔</span>
        <select
          value={right.number}
          onChange={(e) => router.push(`/review/${request.id}/compare?l=${Math.min(left.number, Number(e.target.value) - 1)}&r=${e.target.value}`)}
          className="ds-select-trigger"
          style={{ width: 130, height: 32, fontSize: 12 }}
          title="Right version"
        >
          {versions
            .filter((v) => v.number > 1)
            .map((v) => (
              <option key={v.number} value={v.number}>
                v{v.number} · {v.human ? 'human' : 'model'} · {v.hash}
              </option>
            ))}
        </select>
        <button type="button" onClick={openShip} className="ds-btn ds-btn--default" style={{ height: 36 }}>
          Verdict
          <span style={{ fontSize: 11, background: 'rgba(255,255,255,.22)', borderRadius: 5, padding: '1px 6px' }}>
            ⌘↵
          </span>
        </button>
      </div>

      {repinFor && (
        <div
          style={{
            background: 'var(--blue-50)',
            borderBottom: '1px solid var(--blue-300)',
            color: 'var(--blue-900)',
            padding: '8px 24px',
            fontSize: 13,
          }}
        >
          Re-pin mode — select the correct span on the new version. Esc cancels. Original selector is
          kept in history.
        </div>
      )}
      {budgetReached && request.status !== 'accepted' && (
        <div
          style={{
            background: 'var(--amber-50)',
            borderBottom: '1px solid var(--amber-500)',
            color: 'var(--amber-900)',
            padding: '8px 24px',
            fontSize: 13,
          }}
        >
          Round budget reached. Rejecting again would exceed the policy budget — escalate to the
          operator instead.
        </div>
      )}
      {error && (
        <div
          style={{
            background: 'var(--amber-50)',
            borderBottom: '1px solid var(--amber-500)',
            color: 'var(--amber-900)',
            padding: '8px 24px',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Panes */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', borderRight: '1px solid var(--border)' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
            <div
              style={{
                padding: '8px 16px',
                fontSize: 12,
                color: 'var(--slate-500)',
                background: '#fff',
                borderBottom: '1px solid var(--border)',
              }}
              title="Left version"
            >
              v{left.number} · {left.author} · <span style={{ fontFamily: 'var(--font-mono)' }}>{left.hash.slice(0, 8)}</span>
            </div>
            {renderPane(left.content, leftMarks, (el) => (leftRef.current = el))}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                padding: '8px 16px',
                fontSize: 12,
                color: 'var(--slate-500)',
                background: '#fff',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
              title="Right version"
            >
              <span>
                v{right.number} · {right.author} ·{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{right.hash.slice(0, 8)}</span>
              </span>
              {orphans.length > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'var(--amber-100)',
                    color: 'var(--amber-900)',
                    borderRadius: 9999,
                    padding: '1px 8px',
                  }}
                >
                  ⚑ {orphans.length} orphaned
                </span>
              )}
            </div>
            {renderPane(
              right.content,
              [...rightMarks, ...newMarks],
              (el) => (rightRef.current = el),
              captureRepin,
              'right'
            )}
          </div>
        </div>

        {/* Prior findings rail */}
        <div
          style={{
            width: 340,
            flex: 'none',
            background: '#fff',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ padding: '12px 16px 6px', fontSize: 12, fontWeight: 600, color: 'var(--slate-500)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
            Prior findings — verify against intent
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '4px 16px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ordered.length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>
                No prior findings on this pair.
              </span>
            )}
            {ordered.map((f) => (
              <div
                key={f.id}
                onClick={() => setFocusId(f.id)}
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
                  <span style={{ fontSize: 11, color: 'var(--slate-500)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                      value={retireReason}
                      onChange={(e) => setRetireReason(e.target.value)}
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
                      onClick={() => {
                        const reason = retireReason;
                        setRetireFor(null);
                        setRetireReason('');
                        act(() => retireAction(request.id, f.id, reason));
                      }}
                    >
                      Retire
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ds-btn ds-btn--outline ds-btn--sm"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => act(() => confirmResolutionAction(request.id, f.id, right.id!))}
                    >
                      Resolved <kbd style={{ fontSize: 10 }}>C</kbd>
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn--outline ds-btn--sm"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => act(() => markPersistingAction(request.id, f.id, right.id!))}
                    >
                      Persists <kbd style={{ fontSize: 10 }}>P</kbd>
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn--outline ds-btn--sm"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => setRepinFor(f.id)}
                    >
                      Re-pin <kbd style={{ fontSize: 10 }}>O</kbd>
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost ds-btn--sm"
                      style={{ height: 28, fontSize: 12 }}
                      onClick={() => setRetireFor(f.id)}
                    >
                      Retire <kbd style={{ fontSize: 10 }}>X</kbd>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Verdict sheet */}
      {gateInfo && (
        <div
          onClick={() => setGateInfo(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.45)',
            zIndex: 90,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 12,
              boxShadow: 'var(--shadow-lg)',
              padding: 20,
              width: 520,
              maxWidth: '94vw',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 600 }}>
              Ship a verdict — round {request.round} of {request.roundBudget}
            </div>
            {!criteriaScored && (
              <div style={{ border: '1px solid var(--amber-500)', background: 'var(--amber-50)', color: 'var(--amber-900)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
                Score all criteria to proceed — {unscoredCount} left (in the workspace rail).
              </div>
            )}
            {gateInfo.reasons.length > 0 && (
              <div style={{ border: '1px solid var(--amber-500)', background: 'var(--amber-50)', color: 'var(--amber-900)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.5 }}>
                {gateInfo.reasons.map((r) => (
                  <div key={r}>{r}</div>
                ))}
              </div>
            )}
            {gateInfo.interstitials.length > 0 && (
              <div style={{ border: '1px solid var(--blue-300)', background: 'var(--blue-50)', color: 'var(--blue-900)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.5 }}>
                {gateInfo.interstitials.map((r) => (
                  <div key={r}>{r} — approving records them as auto-confirmed.</div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 12.5, color: 'var(--slate-500)' }}>
              Ships as a signed decision event — verdict, criteria, anchored corrections payload.
              Retried until the pipeline acks.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                onClick={() => ship('approve', true)}
                className="ds-btn ds-btn--default"
                disabled={gateInfo.blocked}
              >
                Approve — seal content hash
              </button>
              <button
                type="button"
                onClick={() => (budgetReached ? setShowEscalate(true) : ship('reject_corrections'))}
                className="ds-btn ds-btn--outline"
                disabled={budgetReached}
                title={budgetReached ? 'Round budget reached — escalate instead' : ''}
              >
                Reject with corrections
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={escReason}
                  onChange={(e) => setEscReason(e.target.value)}
                  placeholder="Escalation reason — required"
                  style={{ flex: 1, border: '1px solid var(--input)', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none' }}
                />
                <button
                  type="button"
                  onClick={() => ship('escalate')}
                  className="ds-btn ds-btn--destructive"
                  disabled={escReason.trim().length < 4}
                >
                  Escalate
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
