'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import {
  addCommentAction,
  claimAction,
  confirmFindingAction,
  dismissFindingAction,
  editCommentAction,
  resolveCommentAction,
  setCriterionAction,
  shipAction,
  gateAction,
} from '@/lib/actions/review';

/**
 * Review Workspace — verbatim port of the prototype: top action bar
 * (Back · unresolved chip · main verdict ⌘↵ · Correct manually), left Task
 * rail (prompt, files, source), center markdown with anchored highlights and
 * selection→composer (with Expected), right rail (Machine review · Criteria
 * with policy-version stamp · Comments with resolve-does-not-ship), edit
 * mode capturing a human-authored version.
 *
 * The verdicts sit in the top bar and ship in one click (VOBO-223). There is no
 * pre-submit sheet: it asked the same four questions a second time. Escalate is
 * gone from the UI; a reject at the last policy round ships and flags the
 * request for an operator. The engine keeps the escalate kind, because the
 * four-state pull contract and existing rows depend on it.
 *
 * MVP: the judge does not run — the machine section renders its empty state.
 */

export interface AnnotationData {
  id: string;
  body: string;
  expected: string | null;
  quote: string;
  startPos: number;
  endPos: number;
  bornRound: number;
  resolved: boolean;
  state: string | null;
  confirmation: string | null;
}

export interface CriterionData {
  id: string;
  title: string;
  description: string | null;
  verdict: 'pass' | 'fail' | 'na' | null;
}

export interface MachineFindingData {
  id: string;
  criterionKey: string;
  severity: 'critical' | 'minor';
  quote: string;
  startPos: number;
  endPos: number;
  evidence: string;
  note: string;
  triage: string;
}

export interface MachineReviewData {
  withheld: boolean;
  pending: boolean;
  failed: boolean;
  overallScore: number | null;
  findings: MachineFindingData[];
}

interface RequestData {
  id: string;
  title: string;
  queueSlug: string;
  projectSlug: string;
  status: string;
  round: number;
  prompt: string | null;
  source: string | null;
  policyLabel: string;
  roundBudget: number;
  budgetExhausted: boolean;
}

const sectionHead: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--slate-500)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
};

const kbdSolid: React.CSSProperties = {
  fontSize: 11,
  background: 'rgba(255,255,255,.22)',
  borderRadius: 5,
  padding: '1px 6px',
};

/** The range the open composer will anchor on. Amber, so it reads as unsaved. */
const pendingStyle: React.CSSProperties = {
  background: 'var(--amber-100)',
  borderBottom: '2px dashed var(--amber-500)',
};

function annStyle(a: AnnotationData): React.CSSProperties {
  if (a.resolved)
    return { background: 'var(--green-100)', borderBottom: '2px solid var(--green-500)' };
  if (a.state === 'persisting')
    return { background: 'var(--red-100)', borderBottom: '2px solid var(--red-500)' };
  return { background: 'var(--blue-100)', borderBottom: '2px solid var(--blue-500)' };
}

export function ReviewWorkspace({
  request,
  contentMd,
  versionId,
  annotations,
  criteria,
  files,
  machineReview = null,
}: {
  request: RequestData;
  contentMd: string;
  versionId: string;
  annotations: AnnotationData[];
  criteria: CriterionData[];
  files: Array<{ name: string; kind: string }>;
  machineReview?: MachineReviewData | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [srcOpen, setSrcOpen] = useState(false);
  const [composer, setComposer] = useState<{ start: number; end: number; phrase: string } | null>(
    null
  );
  const [coText, setCoText] = useState('');
  // The comment being edited, and its working body.
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [gateInfo, setGateInfo] = useState<{ blocked: boolean; reasons: string[]; interstitials: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shipping, setShipping] = useState(false);
  const [ackNeeded, setAckNeeded] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [findingFocus, setFindingFocus] = useState<string | null>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const artifactRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The key handler is bound once; the main verdict changes with the state.
  const mainVerdictRef = useRef<(() => void) | null>(null);
  const saveCommentRef = useRef<() => void>(() => {});
  const railRef = useRef<HTMLDivElement>(null);
  // Set in the same tick so a held ⌘↵ cannot fire save twice before React commits.
  const commentBusyRef = useRef(false);
  const shippingRef = useRef(false);
  const composerOpenRef = useRef(false);
  const coTextRef = useRef('');
  composerOpenRef.current = Boolean(composer);
  coTextRef.current = coText;

  const unresolved = annotations.filter((a) => !a.resolved && a.bornRound === request.round);
  const unscored = criteria.filter((c) => !c.verdict).length;

  // Paragraph + segment model (prototype segs()): split content, overlay
  // annotation ranges, tag every segment with its absolute offset.
  const paragraphs = useMemo(() => {
    const paras: Array<{ start: number; end: number; text: string }> = [];
    const re = /\n\s*\n/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(contentMd)) !== null) {
      if (contentMd.slice(last, m.index).trim())
        paras.push({ start: last, end: m.index, text: contentMd.slice(last, m.index) });
      last = re.lastIndex;
    }
    if (contentMd.slice(last).trim())
      paras.push({ start: last, end: contentMd.length, text: contentMd.slice(last) });
    return paras.map((p) => {
      // The open composer's range is overlaid like an annotation, so the
      // reviewer keeps seeing what they picked. The browser selection is gone
      // the moment they click into the composer.
      const pending =
        composer && composer.start >= p.start && composer.start < p.end
          ? { startPos: composer.start, endPos: composer.end }
          : null;
      const marks = annotations
        .filter((a) => a.startPos >= p.start && a.startPos < p.end)
        .sort((a, b) => a.startPos - b.startPos);
      const overlay: Array<{ startPos: number; endPos: number; ann: AnnotationData | null }> = [
        ...marks.map((a) => ({ startPos: a.startPos, endPos: a.endPos, ann: a })),
        ...(pending ? [{ ...pending, ann: null }] : []),
      ].sort((a, b) => a.startPos - b.startPos);

      const segs: Array<{
        text: string;
        start: number;
        ann: AnnotationData | null;
        pending: boolean;
      }> = [];
      let pos = p.start;
      for (const mark of overlay) {
        if (mark.startPos < pos) continue; // overlap: skip
        if (mark.startPos > pos)
          segs.push({ text: contentMd.slice(pos, mark.startPos), start: pos, ann: null, pending: false });
        const end = Math.min(mark.endPos, p.end);
        segs.push({
          text: contentMd.slice(mark.startPos, end),
          start: mark.startPos,
          ann: mark.ann,
          pending: mark.ann === null,
        });
        pos = end;
      }
      if (pos < p.end)
        segs.push({ text: contentMd.slice(pos, p.end), start: pos, ann: null, pending: false });
      return {
        ...p,
        segs: segs.length ? segs : [{ text: p.text, start: p.start, ann: null, pending: false }],
      };
    });
  }, [contentMd, annotations, composer]);

  const captureSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !artifactRef.current) return;
    const findAbs = (node: Node, offset: number): number | null => {
      let el: HTMLElement | null =
        node.nodeType === Node.TEXT_NODE ? (node.parentElement as HTMLElement) : (node as HTMLElement);
      while (el && el !== artifactRef.current && !el.dataset?.segStart) el = el.parentElement;
      if (!el || !el.dataset?.segStart) return null;
      return Number(el.dataset.segStart) + offset;
    };
    const a = findAbs(sel.anchorNode!, sel.anchorOffset);
    const b = findAbs(sel.focusNode!, sel.focusOffset);
    if (a === null || b === null) return;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end <= start) return;
    setComposer({ start, end, phrase: contentMd.slice(start, end).slice(0, 60) });
    setCoText('');
    setEditing(null);
  };

  // Open the composer: show the right rail, scroll it into view, take the
  // cursor. Selecting text used to change nothing on screen — the reviewer had
  // to hunt for the composer down the rail.
  useEffect(() => {
    if (!composer) return;
    setRightOpen(true);
    const id = window.setTimeout(() => {
      composerRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      composerRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [composer]);

  const saveComment = () => {
    if (!composer || !coText.trim() || commentBusyRef.current) return;
    commentBusyRef.current = true;
    setError(null);
    const { start, end } = composer;
    const body = coText.trim();
    startTransition(async () => {
      try {
        const res = await addCommentAction({
          requestId: request.id,
          body,
          startPos: start,
          endPos: end,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setComposer(null);
        setCoText('');
        router.refresh();
      } finally {
        commentBusyRef.current = false;
      }
    });
  };

  const saveEditedComment = (annotationId: string) => {
    const body = editText.trim();
    if (!body || commentBusyRef.current) return;
    commentBusyRef.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const res = await editCommentAction(request.id, annotationId, body);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setEditing(null);
        router.refresh();
      } finally {
        commentBusyRef.current = false;
      }
    });
  };
  saveCommentRef.current = saveComment;

  const setCriterion = (criterionId: string, verdict: 'pass' | 'fail' | 'na') => {
    startTransition(async () => {
      await setCriterionAction(request.id, criterionId, verdict);
      router.refresh();
    });
  };

  // The gate used to be read only when the sheet opened. It now loads with the
  // page, because the bar has to know whether Approve is blocked before it is
  // clicked, not after.
  useEffect(() => {
    let live = true;
    gateAction(request.id).then((res) => {
      if (live && res.ok && res.data) setGateInfo(res.data as never);
    });
    return () => {
      live = false;
    };
  }, [request.id, annotations.length, criteria]);

  /**
   * Go to the next ranked item, or to the queue when there is none.
   * Mirror QueueScreen.openOrClaim: if the reviewer already holds the next
   * row, open it — claim() refuses a live lease, including our own.
   * not_claimable/claim_race mean someone else got it only when the lease
   * is not ours.
   */
  const advance = async (
    nextRequestId: string | null | undefined,
    nextLeaseMine?: boolean
  ) => {
    if (!nextRequestId) {
      router.push('/queue');
      return;
    }
    if (nextLeaseMine) {
      router.push(`/review/${nextRequestId}`);
      return;
    }
    const claimed = await claimAction(nextRequestId);
    if (claimed.ok) {
      router.push(`/review/${nextRequestId}`);
      return;
    }
    if (claimed.code === 'claim_race' || claimed.code === 'not_claimable') {
      router.push('/queue');
      return;
    }
    router.push('/queue');
  };

  const shipVerdict = (kind: 'approve' | 'reject_corrections' | 'reject_rerun', ack = false) => {
    if (shippingRef.current) return;
    shippingRef.current = true;
    setShipping(true);
    setError(null);
    startTransition(async () => {
      try {
        const res = await shipAction({
          requestId: request.id,
          kind,
          acknowledgeInterstitials: ack,
        });
        if (res.ok) {
          setAckNeeded(false);
          await advance(res.data?.nextRequestId, res.data?.nextLeaseMine);
        } else if (res.code === 'interstitial_unacknowledged') {
          setAckNeeded(true);
          setError(res.error + ' — press the same button again to acknowledge.');
        } else {
          setError(res.error);
        }
      } finally {
        shippingRef.current = false;
        setShipping(false);
      }
    });
  };

  const saveEdit = () => {
    const text = editRef.current?.innerText ?? '';
    if (!text.trim() || shippingRef.current) return;
    shippingRef.current = true;
    setShipping(true);
    startTransition(async () => {
      try {
        const res = await shipAction({
          requestId: request.id,
          kind: 'approve_edited',
          editedContentMd: text,
          acknowledgeInterstitials: true,
        });
        if (res.ok) {
          setAckNeeded(false);
          await advance(res.data?.nextRequestId, res.data?.nextLeaseMine);
        } else {
          setError(res.error);
          setEditMode(false);
        }
      } finally {
        shippingRef.current = false;
        setShipping(false);
      }
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if ((e.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return;
      if (e.key === 'Escape') {
        setComposer(null);
        setEditing(null);
      }
      // ⌘↵ ships the main verdict — unless the composer is open. PR #5 bound
      // the same chord to saveComment; a collapsed selection is a no-op, so
      // the window handler would otherwise approve and drop unsaved coText.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (shippingRef.current) return;
        if (composerOpenRef.current) {
          saveCommentRef.current();
          return;
        }
        if (coTextRef.current.trim()) return;
        mainVerdictRef.current?.();
      }
      if (e.key === 'a' || e.key === 'A') captureSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const compareAvailable = request.round > 1;
  const budgetReached = request.round >= request.roundBudget;
  const rejectBlocked = request.budgetExhausted;
  const queueHref = `/admin/queues/${encodeURIComponent(request.queueSlug)}?project=${encodeURIComponent(
    request.projectSlug
  )}`;

  const untriagedFindings = (machineReview?.findings ?? []).filter((f) => f.triage === 'untriaged');
  const scoreLabel =
    machineReview?.withheld
      ? 'hidden'
      : machineReview?.pending
        ? 'pending'
        : machineReview?.failed
          ? 'failed'
          : machineReview?.overallScore != null
            ? machineReview.overallScore.toFixed(2)
            : '—';

  const confirmFinding = (id: string) => {
    startTransition(async () => {
      const res = await confirmFindingAction(request.id, id);
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  };
  const dismissFinding = (id: string) => {
    const reason = dismissReason.trim();
    if (!reason) {
      setError('A dismiss reason is required');
      return;
    }
    startTransition(async () => {
      const res = await dismissFindingAction(request.id, id, reason);
      if (!res.ok) setError(res.error);
      else {
        setDismissReason('');
        router.refresh();
      }
    });
  };

  mainVerdictRef.current = () => {
    if (shippingRef.current) return;
    if (unresolved.length > 0) {
      if (!rejectBlocked) shipVerdict('reject_corrections');
    } else if (unscored === 0) shipVerdict('approve', ackNeeded);
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Top action bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 24px',
          background: '#fff',
          borderBottom: '1px solid var(--border)',
          flex: 'none',
        }}
      >
        <Link
          href="/queue"
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
          ← Back to queue
        </Link>
        {unresolved.length > 0 && (
          <span
            style={{
              background: 'var(--slate-100)',
              color: 'var(--slate-600)',
              borderRadius: 9999,
              padding: '3px 12px',
              fontSize: 12,
            }}
          >
            {unresolved.length} unresolved comment{unresolved.length > 1 ? 's' : ''}
          </span>
        )}
        {unscored > 0 && (
          <span
            style={{
              background: 'var(--amber-100)',
              color: 'var(--amber-900)',
              borderRadius: 9999,
              padding: '3px 12px',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Score all criteria to proceed — {unscored} left
          </span>
        )}
        {compareAvailable && (
          <Link
            href={`/review/${request.id}/compare`}
            style={{ fontSize: 13, color: 'var(--blue-700)', textDecoration: 'none', fontWeight: 500 }}
          >
            Compare v{request.round - 1} ↔ v{request.round}
          </Link>
        )}
        <div style={{ flex: 1 }} />
        {gateInfo?.blocked && (
          <span
            title={gateInfo.reasons.join(' · ')}
            style={{ fontSize: 12, color: 'var(--slate-500)', maxWidth: 260 }}
          >
            {gateInfo.reasons[0]}
          </span>
        )}
        {/* The verdicts live here. A modal that repeated the same four choices
            made every decision cost two. */}
        {unresolved.length > 0 ? (
          <button
            type="button"
            onClick={() => shipVerdict('reject_corrections')}
            className="ds-btn ds-btn--default"
            disabled={shipping || rejectBlocked}
            title={
              rejectBlocked
                ? 'This request already used the last policy round'
                : `Ships ${unresolved.length} anchored correction(s) with the rejection`
            }
          >
            Reject with corrections ({unresolved.length})
            <span style={kbdSolid}>⌘↵</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => shipVerdict('approve', ackNeeded)}
            className="ds-btn ds-btn--default"
            disabled={shipping || unscored > 0}
            title={
              unscored > 0
                ? `Score all criteria to proceed — ${unscored} left`
                : 'Seals the content hash and ships a signed decision'
            }
          >
            Approve — seal content hash
            <span style={kbdSolid}>⌘↵</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => shipVerdict('reject_rerun')}
          className="ds-btn ds-btn--outline"
          disabled={shipping || rejectBlocked}
          title={
            rejectBlocked
              ? 'This request already used the last policy round'
              : 'Rerun without corrections — the model gets no anchored notes'
          }
        >
          Reject — rerun
        </button>
        <button
          type="button"
          onClick={() => setEditMode(true)}
          className="ds-btn ds-btn--outline"
          disabled={editMode}
        >
          Correct manually
        </button>
      </div>

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
        {/* Left: Task rail */}
        {leftOpen ? (
          <div
            style={{
              width: 290,
              flex: 'none',
              background: '#fff',
              borderRight: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div style={{ padding: '14px 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setLeftOpen(false)}
                title="Hide task pane"
                style={{
                  width: 26,
                  height: 26,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: 'var(--slate-500)',
                  fontSize: 13,
                  background: '#fff',
                }}
              >
                «
              </button>
            </div>
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={sectionHead}>Task</span>
                <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>{request.title}</span>
              </div>
              {request.prompt && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)' }}>Prompt</div>
                  <div
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '12px 14px',
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: 'var(--slate-600)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {request.prompt}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--slate-700)' }}>
                  Files used in processing
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {request.source && (
                    <button
                      type="button"
                      onClick={() => setSrcOpen((o) => !o)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '7px 10px',
                        fontSize: 12.5,
                        background: srcOpen ? 'var(--blue-50)' : '#fff',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <FileText size={13} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        Account dossier
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--slate-400)', textTransform: 'uppercase' }}>
                        source
                      </span>
                    </button>
                  )}
                  {files.map((f) => (
                    <div
                      key={f.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '7px 10px',
                        fontSize: 12.5,
                      }}
                    >
                      <FileText size={13} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.name}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--slate-400)', textTransform: 'uppercase' }}>
                        {f.kind}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              width: 30,
              flex: 'none',
              background: '#fff',
              borderRight: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 14,
            }}
          >
            <button
              type="button"
              onClick={() => setLeftOpen(true)}
              title="Show task pane"
              style={{
                width: 22,
                height: 22,
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--slate-500)',
                fontSize: 13,
                background: '#fff',
              }}
            >
              »
            </button>
          </div>
        )}

        {/* Center: source preview + artifact */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'row' }}>
          {srcOpen && request.source && (
            <div
              style={{
                width: '42%',
                flex: 'none',
                borderRight: '1px solid var(--border)',
                background: 'var(--slate-100)',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 16px',
                  background: '#fff',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <FileText size={13} />
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Account dossier</span>
                <button
                  type="button"
                  onClick={() => setSrcOpen(false)}
                  title="Close preview"
                  style={{ cursor: 'pointer', color: 'var(--slate-400)', fontSize: 15, background: 'none', border: 'none' }}
                >
                  ✕
                </button>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    boxShadow: 'var(--shadow-sm)',
                    padding: '18px 20px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12.5,
                    lineHeight: 1.7,
                    color: 'var(--slate-700)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {request.source}
                </div>
              </div>
            </div>
          )}

          <div
            ref={artifactRef}
            onMouseUp={editMode ? undefined : captureSelection}
            style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
          >
            {editMode ? (
              <div style={{ padding: '24px 40px 12px', maxWidth: 760 }}>
                <div
                  style={{
                    border: '1px solid var(--blue-300)',
                    background: 'var(--blue-50)',
                    borderRadius: 8,
                    padding: '8px 12px',
                    fontSize: 12,
                    color: 'var(--blue-900)',
                    marginBottom: 14,
                  }}
                >
                  Correct manually — your diff is captured as a human-authored version and becomes the
                  acceptance candidate.
                </div>
                <div
                  ref={editRef}
                  contentEditable
                  suppressContentEditableWarning
                  style={{
                    fontSize: 15,
                    lineHeight: 1.8,
                    color: 'var(--slate-800)',
                    outline: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '16px 18px',
                    background: '#fff',
                    whiteSpace: 'pre-wrap',
                    minHeight: 200,
                  }}
                >
                  {contentMd}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={saveEdit} className="ds-btn ds-btn--default">
                    Save as human version
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditMode(false)}
                    className="ds-btn ds-btn--ghost"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: '28px 40px 80px', maxWidth: 760 }}>
                {paragraphs.map((p) => (
                  <div key={p.start} style={{ fontSize: 15, lineHeight: 1.8, color: 'var(--slate-800)', marginBottom: 18, whiteSpace: 'pre-wrap' }}>
                    {p.segs.map((seg) => (
                      <span
                        key={seg.start}
                        data-seg-start={seg.start}
                        style={
                          seg.ann
                            ? annStyle(seg.ann)
                            : seg.pending
                              ? pendingStyle
                              : undefined
                        }
                        title={seg.ann ? seg.ann.body : seg.pending ? 'Selected — write the comment' : undefined}
                      >
                        {seg.text}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: review rail */}
        {rightOpen ? (
          <div
            style={{
              width: 320,
              flex: 'none',
              background: '#fff',
              borderLeft: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div style={{ padding: '14px 16px 0', display: 'flex', justifyContent: 'flex-start' }}>
              <button
                type="button"
                onClick={() => setRightOpen(false)}
                title="Hide review pane"
                style={{
                  width: 26,
                  height: 26,
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: 'var(--slate-500)',
                  fontSize: 13,
                  background: '#fff',
                }}
              >
                »
              </button>
            </div>
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '4px 16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 4px' }}>
                <span style={sectionHead}>Machine review</span>
                <div style={{ flex: 1 }} />
                <span
                  style={{ fontSize: 12, color: 'var(--slate-500)' }}
                  title="The judge score stands in for model confidence in routing. It is never a verdict."
                >
                  {scoreLabel}
                </span>
              </div>
              {machineReview?.withheld ? (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 12,
                    color: 'var(--slate-500)',
                    lineHeight: 1.5,
                  }}
                >
                  Machine review not shown for this item.
                </div>
              ) : machineReview?.pending ? (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 12,
                    color: 'var(--slate-500)',
                  }}
                >
                  Judge run pending.
                </div>
              ) : untriagedFindings.length === 0 && !(machineReview?.findings.length) ? (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 12,
                    color: 'var(--slate-500)',
                    lineHeight: 1.5,
                  }}
                >
                  No machine findings on this version.{' '}
                  <Link href={queueHref} style={{ color: 'var(--blue-700)', textDecoration: 'none', fontWeight: 500 }}>
                    Open the queue page
                  </Link>{' '}
                  to configure the judge.
                </div>
              ) : (
                <>
                  {untriagedFindings.map((f) => (
                    <div
                      key={f.id}
                      data-finding-id={f.id}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: 10,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        background: findingFocus === f.id ? 'var(--slate-50)' : '#fff',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 11, color: 'var(--slate-500)' }}>{f.criterionKey}</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: f.severity === 'critical' ? 'var(--red-700)' : 'var(--slate-600)',
                          }}
                        >
                          {f.severity}
                        </span>
                      </div>
                      <span style={{ fontSize: 13, color: 'var(--slate-800)' }}>{f.note}</span>
                      <span style={{ fontSize: 12, color: 'var(--slate-500)', fontFamily: 'ui-monospace, monospace' }}>
                        “{f.quote}”
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="ds-btn ds-btn--outline ds-btn--sm"
                          onClick={() => confirmFinding(f.id)}
                          title="Confirm C"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="ds-btn ds-btn--outline ds-btn--sm"
                          onClick={() => {
                            setFindingFocus(f.id);
                            dismissFinding(f.id);
                          }}
                          title="Dismiss D"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                  {untriagedFindings.length > 0 && (
                    <input
                      value={dismissReason}
                      onChange={(e) => setDismissReason(e.target.value)}
                      placeholder="Dismiss reason (required)"
                      style={{
                        fontSize: 12,
                        padding: '6px 8px',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                      }}
                    />
                  )}
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px' }}>
                <span style={sectionHead}>Criteria</span>
                <div style={{ flex: 1 }} />
                <span
                  style={{ fontSize: 12, color: 'var(--slate-500)' }}
                  title="Policy version in effect for this review — stamped into the signed event"
                >
                  {request.policyLabel}
                </span>
              </div>
              {criteria.map((c) => (
                <div
                  key={c.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 500 }} title={c.description ?? ''}>
                    {c.title}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['pass', 'fail', 'na'] as const).map((v) => {
                      const active = c.verdict === v;
                      const color =
                        v === 'pass'
                          ? { bg: 'var(--green-100)', fg: 'var(--green-900)' }
                          : v === 'fail'
                            ? { bg: 'var(--red-100)', fg: 'var(--red-900)' }
                            : { bg: 'var(--slate-100)', fg: 'var(--slate-600)' };
                      return (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setCriterion(c.id, v)}
                          style={{
                            borderRadius: 6,
                            padding: '4px 12px',
                            fontSize: 12,
                            fontWeight: 500,
                            cursor: 'pointer',
                            border: active ? `1px solid ${color.fg}` : '1px solid var(--border)',
                            background: active ? color.bg : '#fff',
                            color: active ? color.fg : 'var(--slate-600)',
                          }}
                        >
                          {v === 'na' ? 'N/A' : v === 'pass' ? 'Pass' : 'Fail'}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px' }}>
                <span style={sectionHead}>Comments</span>
                <span
                  style={{
                    background: 'var(--slate-100)',
                    color: 'var(--slate-600)',
                    borderRadius: 9999,
                    padding: '0 8px',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {annotations.length}
                </span>
              </div>

              {composer && (
                <div
                  style={{
                    border: '1px solid var(--blue-300)',
                    background: 'var(--blue-50)',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--blue-900)',
                        flex: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      Anchor comment — “{composer.phrase}”
                    </span>
                    <button
                      type="button"
                      onClick={() => setComposer(null)}
                      style={{ cursor: 'pointer', color: 'var(--slate-400)', fontSize: 15, border: 'none', background: 'none' }}
                    >
                      ✕
                    </button>
                  </div>
                  <textarea
                    ref={composerRef}
                    value={coText}
                    onChange={(e) => setCoText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        if (e.repeat) return;
                        saveComment();
                      }
                      if (e.key === 'Escape') setComposer(null);
                    }}
                    rows={3}
                    placeholder="Comment — what’s wrong here and what the regeneration should say instead"
                    style={{
                      border: '1px solid var(--input)',
                      borderRadius: 6,
                      padding: '8px 10px',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      outline: 'none',
                      resize: 'vertical',
                      background: '#fff',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={saveComment}
                      disabled={!coText.trim()}
                      className="ds-btn ds-btn--default ds-btn--sm"
                    >
                      Comment ⌘↵
                    </button>
                    <button
                      type="button"
                      onClick={() => setComposer(null)}
                      style={{ color: 'var(--slate-500)', fontSize: 12, cursor: 'pointer', background: 'none', border: 'none' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {annotations.length === 0 && !composer && (
                <span style={{ fontSize: 12, color: 'var(--slate-400)', lineHeight: 1.5 }}>
                  No comments yet — select a range in the artifact, or confirm a machine finding.
                </span>
              )}

              {annotations.map((cm) => (
                <div
                  key={cm.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    opacity: cm.resolved ? 0.55 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 9999,
                        padding: '1px 9px',
                        background: cm.resolved ? 'var(--green-100)' : 'var(--blue-100)',
                        color: cm.resolved ? 'var(--green-900)' : 'var(--blue-900)',
                      }}
                    >
                      {cm.resolved ? 'resolved' : `r${cm.bornRound}`}
                    </span>
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
                      “{cm.quote.slice(0, 40)}”
                    </span>
                    {!cm.resolved && editing !== cm.id && (
                      <button
                        type="button"
                        title="Edit this comment"
                        onClick={() => {
                          setEditing(cm.id);
                          setEditText(cm.body);
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          cursor: 'pointer',
                          color: 'var(--slate-400)',
                          background: 'none',
                          border: 'none',
                          fontSize: 12,
                        }}
                      >
                        ✎
                      </button>
                    )}
                    {!cm.resolved && (
                      <button
                        type="button"
                        title="Resolve — stops blocking approve, does not ship"
                        onClick={() =>
                          startTransition(async () => {
                            await resolveCommentAction(request.id, cm.id);
                            router.refresh();
                          })
                        }
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          cursor: 'pointer',
                          color: 'var(--slate-400)',
                          background: 'none',
                          border: 'none',
                        }}
                      >
                        ✓
                      </button>
                    )}
                  </div>
                  {editing === cm.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <textarea
                        autoFocus
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault();
                            if (e.repeat) return;
                            saveEditedComment(cm.id);
                          }
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        rows={3}
                        style={{
                          border: '1px solid var(--input)',
                          borderRadius: 6,
                          padding: '8px 10px',
                          fontSize: 13,
                          fontFamily: 'inherit',
                          outline: 'none',
                          resize: 'vertical',
                          background: '#fff',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => saveEditedComment(cm.id)}
                          disabled={!editText.trim() || editText.trim() === cm.body}
                          className="ds-btn ds-btn--default ds-btn--sm"
                        >
                          Save ⌘↵
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          style={{
                            color: 'var(--slate-500)',
                            fontSize: 12,
                            cursor: 'pointer',
                            background: 'none',
                            border: 'none',
                          }}
                        >
                          Cancel
                        </button>
                        <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                          The anchor stays put — only the text changes.
                        </span>
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{cm.body}</span>
                  )}
                  {/* The composer no longer writes `expected`, but rows from
                      before the change still carry one and must still render. */}
                  {cm.expected && editing !== cm.id && (
                    <span style={{ fontSize: 12, color: 'var(--slate-500)', lineHeight: 1.5 }}>
                      Expected: {cm.expected}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            style={{
              width: 30,
              flex: 'none',
              background: '#fff',
              borderLeft: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 14,
            }}
          >
            <button
              type="button"
              onClick={() => setRightOpen(true)}
              title="Show review pane"
              style={{
                width: 22,
                height: 22,
                border: '1px solid var(--border)',
                borderRadius: 6,
                cursor: 'pointer',
                color: 'var(--slate-500)',
                fontSize: 13,
                background: '#fff',
              }}
            >
              «
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
