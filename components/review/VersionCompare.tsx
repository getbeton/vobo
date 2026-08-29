'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { queueListHref, reviewHref } from '@/lib/shell/crumbs';
import {
  confirmResolutionAction,
  markPersistingAction,
  repinAction,
  retireAction,
  shipAction,
  gateAction,
} from '@/lib/actions/review';
import { ArtifactPane, MarkedText, useSyncScroll } from './ArtifactPane';
import { FindingData, PriorFindingsList } from './PriorFindingsRail';

export type { FindingData };

/**
 * Version Compare — the moat screen, verbatim from the prototype:
 * v(n−1) left / v(n) right with selectors on BOTH panes (original anchor on
 * the left, ghosted landing or margin orphan marker on the right, dashed at
 * low confidence), synchronized scroll, version log rail (any-vs-any,
 * default latest-vs-last-verdicted), prior-findings rail "verify against
 * intent" with Resolved C · Persists P · Re-pin O · Retire X (reason),
 * round-budget banner, decision bar with server gates.
 */

interface VersionInfo {
  number: number;
  content: string;
  author: string;
  hash: string;
  id?: string;
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
  request: {
    id: string;
    title: string;
    round: number;
    roundBudget: number;
    status: string;
    budgetExhausted: boolean;
    projectSlug: string;
    queueSlug: string;
    environment: 'production' | 'test';
  };
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
  const [error, setError] = useState<string | null>(null);
  const [gateInfo, setGateInfo] = useState<{ blocked: boolean; reasons: string[]; interstitials: string[] } | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const reasonRef = useRef<HTMLInputElement | null>(null);

  const prior = findings.filter((f) => f.bornRound < request.round);
  const ordered = useMemo(() => {
    const rank = (f: FindingData) =>
      f.state === 'persisting' ? 0 : f.state === 'orphaned' ? 1 : f.state === 'repinned' ? 2 : 3;
    return [...prior].sort((a, b) => rank(a) - rank(b));
  }, [prior]);

  const budgetReached = request.round >= request.roundBudget;
  useSyncScroll(leftRef, rightRef, true);

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

  const commitRetire = () => {
    if (!retireFor || retireReason.trim().length < 2) return;
    const reason = retireReason;
    const annotationId = retireFor;
    setRetireFor(null);
    setRetireReason('');
    act(() => retireAction(request.id, annotationId, reason));
  };

  const openFollowUp = (kind: 'retire' | 'repin', annotationId: string) => {
    if (kind === 'retire') {
      setRepinFor(null);
      setRetireFor(annotationId);
    } else {
      setRetireFor(null);
      setRetireReason('');
      setRepinFor(annotationId);
      rightRef.current?.focus();
    }
  };

  useEffect(() => {
    if (retireFor) reasonRef.current?.focus();
  }, [retireFor]);

  const openShip = () => {
    startTransition(async () => {
      const res = await gateAction(request.id);
      if (res.ok && res.data) setGateInfo(res.data as any);
    });
  };

  const ship = (kind: 'approve' | 'reject_corrections', ack = false) => {
    setError(null);
    startTransition(async () => {
      const res = await shipAction({
        requestId: request.id,
        kind,
        acknowledgeInterstitials: ack,
      });
      if (res.ok)
        router.push(
          queueListHref({
            projectSlug: request.projectSlug,
            queueSlug: request.queueSlug,
            environment: request.environment,
          })
        );
      else setError(res.error);
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const inField =
        target instanceof HTMLElement &&
        Boolean(target.closest('input,textarea,[contenteditable]'));

      if (e.key === 'Escape') {
        if (retireFor || repinFor) {
          e.preventDefault();
          setRetireFor(null);
          setRepinFor(null);
          setRetireReason('');
          return;
        }
        if (inField) return;
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (retireFor) {
          commitRetire();
          return;
        }
        if (repinFor) {
          captureRepin();
          return;
        }
        if (inField) return;
        openShip();
        return;
      }

      if (inField) return;
      const f = ordered.find((x) => x.id === focusId) ?? ordered[0];
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
      if (e.key === 'o' || e.key === 'O') openFollowUp('repin', f.id);
      if (e.key === 'x' || e.key === 'X') openFollowUp('retire', f.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, focusId, retireFor, repinFor, retireReason]);

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
          href={reviewHref(request.id, {
            projectSlug: request.projectSlug,
            queueSlug: request.queueSlug,
            environment: request.environment,
          })}
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
          onChange={(e) =>
            router.push(
              reviewHref(request.id, {
                projectSlug: request.projectSlug,
                queueSlug: request.queueSlug,
                environment: request.environment,
              }, { compare: true, l: e.target.value, r: right.number })
            )
          }
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
          onChange={(e) =>
            router.push(
              reviewHref(request.id, {
                projectSlug: request.projectSlug,
                queueSlug: request.queueSlug,
                environment: request.environment,
              }, {
                compare: true,
                l: Math.min(left.number, Number(e.target.value) - 1),
                r: e.target.value,
              })
            )
          }
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
          {request.budgetExhausted
            ? 'This request used the last policy round. A further reject is refused.'
            : 'This is the last round. A reject flags the request for an operator.'}
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
            <ArtifactPane
              paneRef={(el) => {
                leftRef.current = el;
              }}
              style={{ padding: '24px 28px 80px' }}
            >
              <MarkedText content={left.content} marks={leftMarks} />
            </ArtifactPane>
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
            <ArtifactPane
              side="right"
              paneRef={(el) => {
                rightRef.current = el;
              }}
              onMouseUp={captureRepin}
              style={{ padding: '24px 28px 80px' }}
            >
              <MarkedText content={right.content} marks={[...rightMarks, ...newMarks]} />
            </ArtifactPane>
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
            <PriorFindingsList
              items={ordered}
              focusId={focusId}
              onFocus={setFocusId}
              retireFor={retireFor}
              retireReason={retireReason}
              onRetireReasonChange={setRetireReason}
              reasonRef={reasonRef}
              onResolved={(id) => act(() => confirmResolutionAction(request.id, id, right.id!))}
              onPersists={(id) => act(() => markPersistingAction(request.id, id, right.id!))}
              onOpenRepin={(id) => openFollowUp('repin', id)}
              onOpenRetire={(id) => openFollowUp('retire', id)}
              onCommitRetire={commitRetire}
              onCancelFollowUp={() => {
                setRetireFor(null);
                setRetireReason('');
              }}
              emptyLabel="No prior findings on this pair."
            />
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
                Score all criteria to proceed — {unscoredCount} left.
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
                onClick={() => ship('reject_corrections')}
                className="ds-btn ds-btn--outline"
                disabled={request.budgetExhausted}
                title={
                  request.budgetExhausted
                    ? 'This request already used the last policy round'
                    : budgetReached
                      ? 'This is the last round. A reject flags the request for an operator.'
                      : ''
                }
              >
                Reject with corrections
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
