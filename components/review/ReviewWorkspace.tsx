'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import {
  addCommentAction,
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
 * mode capturing a human-authored version, pre-submit sheet.
 * MVP: judge not configured — machine section renders its empty state.
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

interface RequestData {
  id: string;
  title: string;
  status: string;
  round: number;
  prompt: string | null;
  source: string | null;
  policyLabel: string;
  roundBudget: number;
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
}: {
  request: RequestData;
  contentMd: string;
  versionId: string;
  annotations: AnnotationData[];
  criteria: CriterionData[];
  files: Array<{ name: string; kind: string }>;
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
  const [coExpected, setCoExpected] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [presubmit, setPresubmit] = useState(false);
  const [gateInfo, setGateInfo] = useState<{ blocked: boolean; reasons: string[]; interstitials: string[] } | null>(null);
  const [escReason, setEscReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const artifactRef = useRef<HTMLDivElement>(null);

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
      const marks = annotations
        .filter((a) => a.startPos >= p.start && a.startPos < p.end)
        .sort((a, b) => a.startPos - b.startPos);
      const segs: Array<{ text: string; start: number; ann: AnnotationData | null }> = [];
      let pos = p.start;
      for (const a of marks) {
        if (a.startPos < pos) continue; // overlap: skip
        if (a.startPos > pos) segs.push({ text: contentMd.slice(pos, a.startPos), start: pos, ann: null });
        const end = Math.min(a.endPos, p.end);
        segs.push({ text: contentMd.slice(a.startPos, end), start: a.startPos, ann: a });
        pos = end;
      }
      if (pos < p.end) segs.push({ text: contentMd.slice(pos, p.end), start: pos, ann: null });
      return { ...p, segs: segs.length ? segs : [{ text: p.text, start: p.start, ann: null }] };
    });
  }, [contentMd, annotations]);

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
    setCoExpected('');
  };

  const saveComment = () => {
    if (!composer || !coText.trim()) return;
    setError(null);
    startTransition(async () => {
      const res = await addCommentAction({
        requestId: request.id,
        body: coText.trim(),
        expected: coExpected.trim() || undefined,
        startPos: composer.start,
        endPos: composer.end,
      });
      if (!res.ok) setError(res.error);
      setComposer(null);
      router.refresh();
    });
  };

  const setCriterion = (criterionId: string, verdict: 'pass' | 'fail' | 'na') => {
    startTransition(async () => {
      await setCriterionAction(request.id, criterionId, verdict);
      router.refresh();
    });
  };

  const openPresubmit = () => {
    startTransition(async () => {
      const res = await gateAction(request.id);
      if (res.ok && res.data) setGateInfo(res.data as any);
      setPresubmit(true);
    });
  };

  const shipVerdict = (
    kind: 'approve' | 'reject_corrections' | 'reject_rerun' | 'escalate',
    ack = false
  ) => {
    setError(null);
    startTransition(async () => {
      const res = await shipAction({
        requestId: request.id,
        kind,
        reason: kind === 'escalate' ? escReason : undefined,
        acknowledgeInterstitials: ack,
      });
      if (res.ok) {
        setPresubmit(false);
        router.push('/queue');
      } else if (res.code === 'interstitial_unacknowledged') {
        setError(res.error + ' — approve again to acknowledge.');
      } else {
        setError(res.error);
      }
    });
  };

  const saveEdit = () => {
    const text = editRef.current?.innerText ?? '';
    if (!text.trim()) return;
    startTransition(async () => {
      const res = await shipAction({
        requestId: request.id,
        kind: 'approve_edited',
        editedContentMd: text,
        acknowledgeInterstitials: true,
      });
      if (res.ok) router.push('/queue');
      else {
        setError(res.error);
        setEditMode(false);
      }
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,[contenteditable]')) return;
      if (e.key === 'Escape') {
        setComposer(null);
        setPresubmit(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') openPresubmit();
      if (e.key === 'a' || e.key === 'A') captureSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mainLabel = unresolved.length > 0 ? 'Reject' : 'Approve';
  const compareAvailable = request.round > 1;

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
        <button
          type="button"
          onClick={openPresubmit}
          className="ds-btn ds-btn--default"
          title={unscored > 0 ? `Score all criteria to proceed — ${unscored} left` : ''}
        >
          {mainLabel}
          <span style={kbdSolid}>⌘↵</span>
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
                        style={seg.ann ? annStyle(seg.ann) : undefined}
                        title={seg.ann ? seg.ann.body : undefined}
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
                  —
                </span>
              </div>
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
                No machine review on this version — the judge is not configured for this queue.
              </div>

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
                    value={coText}
                    onChange={(e) => setCoText(e.target.value)}
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
                  <input
                    value={coExpected}
                    onChange={(e) => setCoExpected(e.target.value)}
                    placeholder="Expected — a testable outcome for the fix"
                    style={{
                      border: '1px solid var(--input)',
                      borderRadius: 6,
                      padding: '7px 10px',
                      fontSize: 13,
                      fontFamily: 'inherit',
                      outline: 'none',
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
                      Comment
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
                  <span style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{cm.body}</span>
                  {cm.expected && (
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

      {/* Pre-submit sheet */}
      {presubmit && (
        <div
          onClick={() => setPresubmit(false)}
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
              maxHeight: '84vh',
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 600 }}>Ship a verdict — round {request.round} of {request.roundBudget}</div>
            <div style={{ fontSize: 12.5, color: 'var(--slate-500)', lineHeight: 1.5 }}>
              Ships as a signed decision event — verdict, criteria, anchored corrections payload.
              Retried until the pipeline acks.
            </div>
            {gateInfo && gateInfo.reasons.length > 0 && (
              <div
                style={{
                  border: '1px solid var(--amber-500)',
                  background: 'var(--amber-50)',
                  color: 'var(--amber-900)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
              >
                {gateInfo.reasons.map((r) => (
                  <div key={r}>{r}</div>
                ))}
              </div>
            )}
            {gateInfo && gateInfo.interstitials.length > 0 && (
              <div
                style={{
                  border: '1px solid var(--blue-300)',
                  background: 'var(--blue-50)',
                  color: 'var(--blue-900)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12.5,
                  lineHeight: 1.5,
                }}
              >
                {gateInfo.interstitials.map((r) => (
                  <div key={r}>{r}</div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 13 }}>
              <strong>{unresolved.length}</strong> anchored correction
              {unresolved.length === 1 ? '' : 's'} ship with a rejection · criteria{' '}
              {criteria.length - unscored}/{criteria.length} scored
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                onClick={() => shipVerdict('approve', true)}
                className="ds-btn ds-btn--default"
                disabled={Boolean(gateInfo?.blocked)}
              >
                Approve — seal content hash
              </button>
              <button
                type="button"
                onClick={() => shipVerdict('reject_corrections')}
                className="ds-btn ds-btn--outline"
                disabled={unresolved.length === 0}
              >
                Reject with corrections ({unresolved.length})
              </button>
              <button
                type="button"
                onClick={() => shipVerdict('reject_rerun')}
                className="ds-btn ds-btn--outline"
              >
                Reject — rerun without corrections
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={escReason}
                  onChange={(e) => setEscReason(e.target.value)}
                  placeholder="Escalation reason — required"
                  style={{
                    flex: 1,
                    border: '1px solid var(--input)',
                    borderRadius: 6,
                    padding: '7px 10px',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={() => shipVerdict('escalate')}
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
