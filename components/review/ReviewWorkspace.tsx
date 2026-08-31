'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { queueListHref, reviewHref, type QueueRef } from '@/lib/shell/crumbs';
import {
  addCommentAction,
  claimAction,
  confirmResolutionAction,
  editCommentAction,
  markPersistingAction,
  repinAction,
  resolveCommentAction,
  retireAction,
  setCriterionAction,
  shipAction,
  gateAction,
  createSuggestionAction,
  acceptSuggestionAction,
  rejectSuggestionAction,
  saveManualEditsAction,
  rerunJudgeAction,
} from '@/lib/actions/review';
import { applyManualEdits } from '@/lib/core/manual-edits';
import type { RemainingWork } from '@/lib/core/metrics';
import { RemainingWorkChip } from '@/components/queue/RemainingWorkChip';
import { SuggestionList, type SuggestionData } from './SuggestionLayer';

export type { SuggestionData };
import { ArtifactPane, MarkedText, useSyncScroll, type CompareMark } from './ArtifactPane';
import { FindingData, PriorFindingsList } from './PriorFindingsRail';

/**
 * Review Workspace — top action bar (Back · unresolved chip · one verdict ⌘↵),
 * left Task rail, center markdown with anchored highlights. Select a span,
 * then type to suggest a replacement, Backspace to suggest a delete, or ⌘⇧M
 * to comment in the right rail.
 *
 * A judge run folds into the criterion cards: collapsed they show unwrap +
 * name + 0–1 confidence. Unwrap reveals Pass / Fail / N/A so a human can
 * override. Hover or focus on a card highlights the span the judge used.
 *
 * Keyboard: Enter = pass and next criterion, Backspace = fail and next
 * (when no span is selected). ⌘⇧M comments on the selection. ⌘↵ ships
 * the single verdict, then opens the next queue item.
 */

type SpanPick = { start: number; end: number; phrase: string };

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
  confidence?: string | null;
  landing?: { start: number; end: number; quote: string } | null;
}

export interface CriterionFinding {
  startPos: number;
  endPos: number;
  passed: boolean;
  note: string;
}

export interface CriterionData {
  id: string;
  key?: string;
  title: string;
  description: string | null;
  verdict: 'pass' | 'fail' | 'na' | null;
  source?: 'human' | 'machine' | null;
  /** 0–1 model confidence that this criterion passed. Null when no judge. */
  score?: number | null;
  finding?: CriterionFinding | null;
}

export interface MachineReviewData {
  withheld: boolean;
  pending: boolean;
  failed: boolean;
  overallScore: number | null;
  runState?: 'pending' | 'running' | 'completed' | 'failed' | 'not_sampled' | null;
  judgeEnabled?: boolean;
}

interface RequestData {
  id: string;
  title: string;
  queueSlug: string;
  projectSlug: string;
  environment: 'production' | 'test';
  status: string;
  round: number;
  prompt: string | null;
  source: string | null;
  policyLabel: string;
  roundBudget: number;
  budgetExhausted: boolean;
}

function queueRef(request: RequestData): QueueRef {
  return {
    projectSlug: request.projectSlug,
    queueSlug: request.queueSlug,
    environment: request.environment,
  };
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

const suggestionStyle: React.CSSProperties = {
  background: 'var(--amber-50)',
  borderBottom: '2px dashed var(--amber-600)',
};

const judgePassStyle: React.CSSProperties = {
  background: 'var(--green-100)',
  borderBottom: '2px solid var(--green-500)',
};

const judgeFailStyle: React.CSSProperties = {
  background: 'var(--red-100)',
  borderBottom: '2px solid var(--red-500)',
};

function annStyle(a: AnnotationData): React.CSSProperties {
  if (a.resolved)
    return { background: 'var(--green-100)', borderBottom: '2px solid var(--green-500)' };
  if (a.state === 'persisting')
    return { background: 'var(--red-100)', borderBottom: '2px solid var(--red-500)' };
  return { background: 'var(--blue-100)', borderBottom: '2px solid var(--blue-500)' };
}

function formatScore(score: number | null | undefined): string {
  if (score == null || Number.isNaN(score)) return '—';
  return Math.min(1, Math.max(0, score)).toFixed(2);
}

type OverlayMark = {
  startPos: number;
  endPos: number;
  ann: AnnotationData | null;
  pending: boolean;
  suggestion: boolean;
  judge: 'pass' | 'fail' | null;
  focused?: boolean;
};

function annotationPaintRange(
  a: AnnotationData,
  round: number
): { startPos: number; endPos: number } | null {
  if (a.bornRound >= round) return { startPos: a.startPos, endPos: a.endPos };
  if (a.landing && a.landing.end > a.landing.start) {
    return { startPos: a.landing.start, endPos: a.landing.end };
  }
  if (a.state === 'orphaned') return null;
  return { startPos: a.startPos, endPos: a.endPos };
}

function priorDisplayState(f: {
  confirmation: string | null;
  resolved?: boolean;
  resolvedComment?: boolean;
  state: string | null;
}): string {
  if (f.confirmation === 'res' || f.resolved || f.resolvedComment) return 'resolved';
  if (f.confirmation === 'per') return 'persisting';
  return f.state ?? 'new';
}

export function ReviewWorkspace({
  request,
  contentMd,
  previousContentMd = null,
  versionId,
  versions = [],
  annotations,
  criteria,
  files,
  machineReview = null,
  suggestions = [],
  remainingWork = null,
}: {
  request: RequestData;
  contentMd: string;
  previousContentMd?: string | null;
  versionId: string;
  versions?: Array<{ id: string; number: number; author: string; hash: string }>;
  annotations: AnnotationData[];
  criteria: CriterionData[];
  files: Array<{ name: string; kind: string }>;
  machineReview?: MachineReviewData | null;
  suggestions?: SuggestionData[];
  remainingWork?: RemainingWork | null;
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
  const [liveSel, setLiveSel] = useState<SpanPick | null>(null);
  const [suggest, setSuggest] = useState<SpanPick | null>(null);
  const [suggestText, setSuggestText] = useState('');
  const [gateInfo, setGateInfo] = useState<{ blocked: boolean; reasons: string[]; interstitials: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shipping, setShipping] = useState(false);
  const [ackNeeded, setAckNeeded] = useState(false);
  const [localVerdict, setLocalVerdict] = useState<Record<string, 'pass' | 'fail' | 'na'>>({});
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [focusedCriterionId, setFocusedCriterionId] = useState<string | null>(null);
  const [hoverRange, setHoverRange] = useState<{
    startPos: number;
    endPos: number;
    passed: boolean;
  } | null>(null);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const artifactRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const suggestInputRef = useRef<HTMLTextAreaElement>(null);
  const liveSelRef = useRef<SpanPick | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const [currentOnly, setCurrentOnly] = useState(false);
  const [repinFor, setRepinFor] = useState<string | null>(null);
  const [retireFor, setRetireFor] = useState<string | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [focusFindingId, setFocusFindingId] = useState<string | null>(null);
  const [acceptVersionId, setAcceptVersionId] = useState(versionId);
  useEffect(() => {
    setAcceptVersionId(versionId);
  }, [versionId]);
  const versionList =
    versions.length > 0
      ? versions
      : [{ id: versionId, number: request.round, author: '', hash: '' }];
  const sealingPrior = acceptVersionId !== versionId;
  // The key handler is bound once; the main verdict changes with the state.
  const mainVerdictRef = useRef<(() => void) | null>(null);
  const saveCommentRef = useRef<() => void>(() => {});
  const saveSuggestionRef = useRef<() => void>(() => {});
  const openCommentOnRef = useRef<(range: SpanPick) => void>(() => {});
  const startSuggestDraftRef = useRef<(range: SpanPick, firstChar: string) => void>(() => {});
  const persistSuggestionRef = useRef<(range: SpanPick, replacement: string) => void>(() => {});
  const readSelectionRef = useRef<() => SpanPick | null>(() => null);
  const railRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Set in the same tick so a held ⌘↵ cannot fire save twice before React commits.
  const commentBusyRef = useRef(false);
  const shippingRef = useRef(false);
  const composerOpenRef = useRef(false);
  const suggestOpenRef = useRef(false);
  const editingOpenRef = useRef(false);
  const coTextRef = useRef('');
  const saveEditRef = useRef<() => void>(() => {});
  const repinForRef = useRef<string | null>(null);
  const retireForRef = useRef<string | null>(null);
  const retireReasonRef = useRef('');
  const focusFindingIdRef = useRef<string | null>(null);
  const priorItemsRef = useRef<FindingData[]>([]);
  composerOpenRef.current = Boolean(composer);
  suggestOpenRef.current = Boolean(suggest);
  editingOpenRef.current = Boolean(editing);
  liveSelRef.current = liveSel;
  coTextRef.current = coText;
  repinForRef.current = repinFor;
  retireForRef.current = retireFor;
  retireReasonRef.current = retireReason;
  focusFindingIdRef.current = focusFindingId;

  const unresolved = annotations.filter((a) => !a.resolved && a.bornRound === request.round);
  const scoredCriteria = criteria.map((c) => ({
    ...c,
    verdict: localVerdict[c.id] ?? c.verdict,
  }));
  const unscored = scoredCriteria.filter((c) => !c.verdict).length;
  const criteriaNotMet = scoredCriteria.some((c) => c.verdict !== 'pass');
  const shouldReject = unresolved.length > 0 || criteriaNotMet;
  const appliedSuggestions = suggestions.filter((s) => s.status === 'applied');
  const pendingSuggestions = suggestions.filter((s) => s.status === 'pending');
  const displayMd = useMemo(
    () => applyManualEdits(contentMd, appliedSuggestions),
    [contentMd, appliedSuggestions]
  );

  // Paragraph + segment model (prototype segs()): split content, overlay
  // annotation ranges, tag every segment with its absolute offset.
  const paragraphs = useMemo(() => {
    const paras: Array<{ start: number; end: number; text: string }> = [];
    const re = /\n\s*\n/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(displayMd)) !== null) {
      if (displayMd.slice(last, m.index).trim())
        paras.push({ start: last, end: m.index, text: displayMd.slice(last, m.index) });
      last = re.lastIndex;
    }
    if (displayMd.slice(last).trim())
      paras.push({ start: last, end: displayMd.length, text: displayMd.slice(last) });
    return paras.map((p) => {
      // Live selection, comment composer, or suggestion draft — same amber
      // mark. The browser selection is gone the moment they type or comment.
      const pick = composer ?? suggest ?? liveSel;
      const pending =
        pick && pick.start >= p.start && pick.start < p.end
          ? { startPos: pick.start, endPos: pick.end }
          : null;
      const highlight =
        hoverRange && hoverRange.startPos < p.end && hoverRange.endPos > p.start
          ? {
              startPos: Math.max(hoverRange.startPos, p.start),
              endPos: Math.min(hoverRange.endPos, p.end),
              passed: hoverRange.passed,
            }
          : null;
      const marks = annotations
        .map((a) => {
          const range = annotationPaintRange(a, request.round);
          if (!range) return null;
          if (!(range.startPos >= p.start && range.startPos < p.end)) return null;
          return { ann: a, startPos: range.startPos, endPos: range.endPos };
        })
        .filter((row): row is { ann: AnnotationData; startPos: number; endPos: number } => row !== null)
        .sort((a, b) => a.startPos - b.startPos);
      const suggestionMarks = pendingSuggestions.filter(
        (s) => s.startPos >= p.start && s.startPos < p.end
      );
      const overlay: OverlayMark[] = [
        ...marks.map((row) => ({
          startPos: row.startPos,
          endPos: row.endPos,
          ann: row.ann,
          pending: false,
          suggestion: false,
          judge: null,
          focused: row.ann.id === focusFindingId,
        })),
        ...(pending
          ? [
              {
                startPos: pending.startPos,
                endPos: pending.endPos,
                ann: null,
                pending: true,
                suggestion: false,
                judge: null,
              },
            ]
          : []),
        ...suggestionMarks.map((s) => ({
          startPos: s.startPos,
          endPos: s.endPos,
          ann: null,
          pending: false,
          suggestion: true,
          judge: null,
        })),
        ...(highlight
          ? [
              {
                startPos: highlight.startPos,
                endPos: highlight.endPos,
                ann: null,
                pending: false,
                suggestion: false,
                judge: (highlight.passed ? 'pass' : 'fail') as 'pass' | 'fail',
              },
            ]
          : []),
      ].sort((a, b) => {
        if (a.startPos !== b.startPos) return a.startPos - b.startPos;
        const rank = (m: OverlayMark) => (m.ann ? 0 : m.pending ? 1 : m.suggestion ? 2 : 3);
        return rank(a) - rank(b);
      });

      const segs: Array<{
        text: string;
        start: number;
        ann: AnnotationData | null;
        pending: boolean;
        suggestion: boolean;
        judge: 'pass' | 'fail' | null;
        focused: boolean;
      }> = [];
      let pos = p.start;
      for (const mark of overlay) {
        if (mark.startPos < pos) continue; // overlap: skip
        if (mark.startPos > pos)
          segs.push({
            text: displayMd.slice(pos, mark.startPos),
            start: pos,
            ann: null,
            pending: false,
            suggestion: false,
            judge: null,
            focused: false,
          });
        const end = Math.min(mark.endPos, p.end);
        segs.push({
          text: displayMd.slice(mark.startPos, end),
          start: mark.startPos,
          ann: mark.ann,
          pending: mark.pending,
          suggestion: mark.suggestion,
          judge: mark.judge,
          focused: Boolean(mark.focused),
        });
        pos = end;
      }
      if (pos < p.end)
        segs.push({
          text: displayMd.slice(pos, p.end),
          start: pos,
          ann: null,
          pending: false,
          suggestion: false,
          judge: null,
          focused: false,
        });
      return {
        ...p,
        segs: segs.length
          ? segs
          : [
              {
                text: p.text,
                start: p.start,
                ann: null,
                pending: false,
                suggestion: false,
                judge: null,
                focused: false,
              },
            ],
      };
    });
  }, [
    displayMd,
    annotations,
    composer,
    suggest,
    liveSel,
    hoverRange,
    pendingSuggestions,
    request.round,
    focusFindingId,
  ]);

  const splitAvailable = request.round >= 2 && Boolean(previousContentMd);
  const splitOpen = splitAvailable && !currentOnly;
  useSyncScroll(leftRef, artifactRef, splitOpen);

  const priorItems: FindingData[] = useMemo(() => {
    const prior = annotations.filter((a) => a.bornRound < request.round);
    const rank = (f: AnnotationData) =>
      f.state === 'persisting' ? 0 : f.state === 'orphaned' ? 1 : f.state === 'repinned' ? 2 : 3;
    return [...prior]
      .sort((a, b) => rank(a) - rank(b))
      .map((a) => ({
        id: a.id,
        body: a.body,
        expected: a.expected,
        quote: a.quote,
        startPos: a.startPos,
        endPos: a.endPos,
        bornRound: a.bornRound,
        resolvedComment: a.resolved,
        state: a.state,
        confidence: a.confidence ?? null,
        confirmation: a.confirmation,
        landing: a.landing ?? null,
      }));
  }, [annotations, request.round]);
  priorItemsRef.current = priorItems;
  const previousMarks: CompareMark[] = useMemo(() => {
    if (!previousContentMd) return [];
    return priorItems.flatMap((f) => {
      const start = previousContentMd.indexOf(f.quote);
      if (start < 0) return [];
      return [
        {
          start,
          end: start + f.quote.length,
          state: priorDisplayState(f),
          low: f.confidence === 'low',
          focused: f.id === focusFindingId,
        },
      ];
    });
  }, [previousContentMd, priorItems, focusFindingId]);
  const roundComments = annotations.filter((a) => a.bornRound === request.round);

  const findAbsInPane = (pane: HTMLElement, node: Node, offset: number): number | null => {
    let el: HTMLElement | null =
      node.nodeType === Node.TEXT_NODE ? (node.parentElement as HTMLElement) : (node as HTMLElement);
    while (el && el !== pane && !el.dataset?.segStart) el = el.parentElement;
    if (!el || !el.dataset?.segStart || !pane.contains(el)) return null;
    return Number(el.dataset.segStart) + offset;
  };

  const readSelection = (): SpanPick | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !artifactRef.current) return null;
    const pane = artifactRef.current;
    const a = findAbsInPane(pane, sel.anchorNode!, sel.anchorOffset);
    const b = findAbsInPane(pane, sel.focusNode!, sel.focusOffset);
    if (a === null || b === null) return null;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end <= start) return null;
    return { start, end, phrase: displayMd.slice(start, end).slice(0, 60) };
  };

  const captureSelection = () => {
    if (repinForRef.current) return;
    const range = readSelection();
    if (!range) return;
    setLiveSel(range);
    setComposer(null);
    setCoText('');
    setEditing(null);
    setSuggest(null);
    setSuggestText('');
    artifactRef.current?.focus();
  };

  const openCommentOn = (range: SpanPick) => {
    setComposer(range);
    setCoText('');
    setEditing(null);
    setSuggest(null);
    setSuggestText('');
    setLiveSel(null);
    setRightOpen(true);
  };

  const startSuggestDraft = (range: SpanPick, firstChar: string) => {
    setSuggest(range);
    setSuggestText(firstChar);
    setComposer(null);
    setLiveSel(null);
    setRightOpen(true);
  };

  const persistSuggestion = (range: SpanPick, replacement: string) => {
    if (commentBusyRef.current) return;
    commentBusyRef.current = true;
    setLiveSel(null);
    setSuggest(null);
    setSuggestText('');
    startTransition(async () => {
      try {
        const res = await createSuggestionAction({
          requestId: request.id,
          startPos: range.start,
          endPos: range.end,
          replacement,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        router.refresh();
      } finally {
        commentBusyRef.current = false;
      }
    });
  };

  const captureRepin = () => {
    const annotationId = repinForRef.current;
    if (!annotationId) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !artifactRef.current) return;
    const pane = artifactRef.current;
    const a = findAbsInPane(pane, sel.anchorNode!, sel.anchorOffset);
    const b = findAbsInPane(pane, sel.focusNode!, sel.focusOffset);
    if (a === null || b === null) return;
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end <= start) return;
    setRepinFor(null);
    startTransition(async () => {
      await repinAction({
        requestId: request.id,
        annotationId,
        versionId,
        newQuote: displayMd.slice(start, end),
        newStartPos: start,
        newEndPos: end,
      });
      router.refresh();
    });
  };

  const onCurrentMouseUp = () => {
    if (repinForRef.current) captureRepin();
    else captureSelection();
  };

  const saveSuggestion = () => {
    if (!suggest || commentBusyRef.current) return;
    persistSuggestion(suggest, suggestText);
  };
  saveSuggestionRef.current = saveSuggestion;

  useEffect(() => {
    if (retireFor) reasonRef.current?.focus();
  }, [retireFor]);

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

  useEffect(() => {
    if (!suggest) return;
    setRightOpen(true);
    const id = window.setTimeout(() => {
      const el = suggestInputRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }, 0);
    return () => window.clearTimeout(id);
  }, [suggest]);

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
  saveEditRef.current = () => {
    if (editing) saveEditedComment(editing);
  };

  const setCriterion = (criterionId: string, verdict: 'pass' | 'fail' | 'na') => {
    setLocalVerdict((prev) => ({ ...prev, [criterionId]: verdict }));
    startTransition(async () => {
      await setCriterionAction(request.id, criterionId, verdict);
      router.refresh();
    });
  };

  const showFinding = (c: CriterionData | undefined) => {
    if (c?.finding && c.finding.endPos > c.finding.startPos) {
      setHoverRange({
        startPos: c.finding.startPos,
        endPos: c.finding.endPos,
        passed: c.finding.passed,
      });
    } else {
      setHoverRange(null);
    }
  };

  const focusCriterion = (id: string) => {
    setFocusedCriterionId(id);
    const card = cardRefs.current[id];
    card?.focus();
    showFinding(scoredCriteria.find((c) => c.id === id));
  };

  const focusNextCriterion = (fromId: string) => {
    const idx = scoredCriteria.findIndex((c) => c.id === fromId);
    const next = scoredCriteria[idx + 1];
    if (next) {
      // Defer so the current keydown finishes before the next card takes focus.
      window.setTimeout(() => focusCriterion(next.id), 0);
    }
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

  // Land in the criteria pane on the first card. The fly-through starts there.
  useEffect(() => {
    const first = criteria[0]?.id;
    if (!first) return;
    setRightOpen(true);
    const id = window.setTimeout(() => {
      const card = cardRefs.current[first];
      if (!card) return;
      card.focus();
      setFocusedCriterionId(first);
      const row = criteria.find((c) => c.id === first);
      if (row?.finding && row.finding.endPos > row.finding.startPos) {
        setHoverRange({
          startPos: row.finding.startPos,
          endPos: row.finding.endPos,
          passed: row.finding.passed,
        });
      }
    }, 0);
    return () => window.clearTimeout(id);
    // Only on a new request — a refresh must not steal the composer cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);

  useEffect(() => {
    if (!hoverRange) return;
    const el = artifactRef.current?.querySelector('[data-judge-hl]') as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
  }, [hoverRange, focusedCriterionId]);

  useEffect(() => {
    if (!focusFindingId) return;
    const el = document.querySelector('[data-prior-focused]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusFindingId]);

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
    const list = queueListHref(queueRef(request));
    if (!nextRequestId) {
      router.push(list);
      return;
    }
    if (nextLeaseMine) {
      router.push(reviewHref(nextRequestId, queueRef(request)));
      return;
    }
    const claimed = await claimAction(nextRequestId);
    if (claimed.ok) {
      router.push(reviewHref(nextRequestId, queueRef(request)));
      return;
    }
    if (claimed.code === 'claim_race' || claimed.code === 'not_claimable') {
      router.push(list);
      return;
    }
    router.push(list);
  };

  const shipVerdict = (
    kind: 'approve' | 'reject_corrections' | 'reject_rerun',
    ack = false,
    acceptedVersionId?: string
  ) => {
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
          ...(kind === 'approve' && acceptedVersionId ? { acceptedVersionId } : {}),
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

  const saveEdits = () => {
    if (shippingRef.current) return;
    if (pendingSuggestions.length > 0) {
      setError('Accept or reject open suggestions first');
      return;
    }
    shippingRef.current = true;
    setShipping(true);
    setError(null);
    startTransition(async () => {
      try {
        const res = await saveManualEditsAction(request.id);
        if (!res.ok) setError(res.error);
        else router.refresh();
      } finally {
        shippingRef.current = false;
        setShipping(false);
      }
    });
  };

  const budgetReached = request.round >= request.roundBudget;
  const rejectBlocked = request.budgetExhausted;

  const commitRetire = () => {
    const annotationId = retireForRef.current;
    const reason = retireReasonRef.current;
    if (!annotationId || reason.trim().length < 2) return;
    setRetireFor(null);
    setRetireReason('');
    startTransition(async () => {
      await retireAction(request.id, annotationId, reason);
      router.refresh();
    });
  };

  const openFollowUp = (kind: 'retire' | 'repin', annotationId: string) => {
    if (kind === 'retire') {
      setRepinFor(null);
      setRetireFor(annotationId);
    } else {
      setRetireFor(null);
      setRetireReason('');
      setRepinFor(annotationId);
      artifactRef.current?.focus();
    }
  };

  const fireMainVerdict = () => {
    if (shippingRef.current) return;
    if (appliedSuggestions.length > 0 && pendingSuggestions.length === 0) {
      saveEdits();
      return;
    }
    if (pendingSuggestions.length > 0) {
      setError('Accept or reject open suggestions first');
      return;
    }
    if (machineReview?.pending) return;
    if (unscored > 0) {
      setError(`Score all criteria to proceed — ${unscored} left`);
      return;
    }
    if (shouldReject && rejectBlocked && !sealingPrior) return;
    if ((sealingPrior || !shouldReject) && gateInfo?.blocked) {
      setError(gateInfo.reasons[0] ?? 'Approve is blocked');
      return;
    }
    if (sealingPrior) {
      shipVerdict('approve', true, acceptVersionId);
      return;
    }
    if (shouldReject) {
      if (rejectBlocked) return;
      shipVerdict(unresolved.length > 0 ? 'reject_corrections' : 'reject_rerun');
      return;
    }
    shipVerdict('approve', ackNeeded, acceptVersionId);
  };
  mainVerdictRef.current = fireMainVerdict;
  openCommentOnRef.current = openCommentOn;
  startSuggestDraftRef.current = startSuggestDraft;
  persistSuggestionRef.current = persistSuggestion;
  readSelectionRef.current = readSelection;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const target = e.target;
      const inField =
        target instanceof HTMLElement &&
        Boolean(target.closest('input,textarea,[contenteditable]'));
      if (e.key === 'Escape') {
        if (retireForRef.current || repinForRef.current) {
          e.preventDefault();
          setRetireFor(null);
          setRepinFor(null);
          setRetireReason('');
          return;
        }
        if (inField) return;
        setComposer(null);
        setCoText('');
        coTextRef.current = '';
        setEditing(null);
        setLiveSel(null);
        setSuggest(null);
        return;
      }
      // ⌘↵ ships the main verdict — unless the composer is open. PR #5 bound
      // the same chord to saveComment; a collapsed selection is a no-op, so
      // the window handler would otherwise approve and drop unsaved coText.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (shippingRef.current) return;
        if (suggestOpenRef.current) {
          saveSuggestionRef.current();
          return;
        }
        if (composerOpenRef.current) {
          saveCommentRef.current();
          return;
        }
        if (editingOpenRef.current) {
          saveEditRef.current();
          return;
        }
        if (retireForRef.current) {
          commitRetire();
          return;
        }
        if (repinForRef.current) {
          captureRepin();
          return;
        }
        if (inField) return;
        if (coTextRef.current.trim()) return;
        mainVerdictRef.current?.();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')
      ) {
        e.preventDefault();
        const range = liveSelRef.current ?? readSelectionRef.current();
        if (range) openCommentOnRef.current(range);
        return;
      }
      if (e.defaultPrevented) return;
      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const f = priorItemsRef.current.find((x) => x.id === focusFindingIdRef.current);
      const k = e.key;
      if (f && (k === 'c' || k === 'C' || k === 'p' || k === 'P' || k === 'o' || k === 'O' || k === 'x' || k === 'X')) {
        e.preventDefault();
        if (k === 'c' || k === 'C') {
          startTransition(async () => {
            await confirmResolutionAction(request.id, f.id, versionId);
            router.refresh();
          });
        } else if (k === 'p' || k === 'P') {
          startTransition(async () => {
            await markPersistingAction(request.id, f.id, versionId);
            router.refresh();
          });
        } else if (k === 'o' || k === 'O') {
          openFollowUp('repin', f.id);
        } else {
          openFollowUp('retire', f.id);
        }
        return;
      }
      if (f && k === '?') return;
      const live = liveSelRef.current;
      if (live) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          persistSuggestionRef.current(live, '');
          return;
        }
        if (e.key.length === 1) {
          e.preventDefault();
          startSuggestDraftRef.current(live, e.key);
          return;
        }
      }
      if (e.key === 'a' || e.key === 'A') captureSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const judgeStatus = machineReview?.withheld
    ? 'hidden'
    : machineReview?.pending
      ? 'pending'
      : machineReview?.failed
        ? 'failed'
        : machineReview?.runState === 'not_sampled'
          ? 'not sampled'
          : machineReview?.runState === 'completed'
            ? 'done'
            : null;

  const runState = machineReview?.runState ?? null;
  const rerunAllowed = Boolean(
    machineReview?.judgeEnabled &&
      runState &&
      request.status !== 'accepted' &&
      ['completed', 'failed', 'not_sampled', 'running', 'pending'].includes(runState)
  );
  const rerunBusy = runState === 'running' || runState === 'pending';

  const showSave = appliedSuggestions.length > 0;
  const showAccept = !showSave && (sealingPrior || !shouldReject);
  const verdictDisabled =
    shipping ||
    pendingSuggestions.length > 0 ||
    Boolean(machineReview?.pending && !showSave) ||
    (!showSave && unscored > 0) ||
    (!showSave && !sealingPrior && shouldReject && rejectBlocked) ||
    (showAccept && Boolean(gateInfo?.blocked));

  const verdictTitle = unscored > 0
    ? `Score all criteria to proceed — ${unscored} left`
    : shouldReject
      ? rejectBlocked
        ? 'This request already used the last policy round'
        : unresolved.length > 0
          ? `Ships ${unresolved.length} anchored correction(s) with the rejection`
          : 'Reject and rerun without corrections'
      : gateInfo?.blocked
        ? gateInfo.reasons[0]
        : 'Seals the content hash and ships a signed decision';

  const currentParagraphs = (
    <div style={{ padding: '28px 40px 80px', maxWidth: 760 }}>
      {paragraphs.map((p) => (
        <div
          key={p.start}
          style={{
            fontSize: 15,
            lineHeight: 1.8,
            color: 'var(--slate-800)',
            marginBottom: 18,
            whiteSpace: 'pre-wrap',
          }}
        >
          {p.segs.map((seg) => (
            <span
              key={`${seg.start}-${seg.pending ? 'p' : ''}-${seg.suggestion ? 's' : ''}-${seg.judge ?? ''}-${seg.ann?.id ?? ''}`}
              data-seg-start={seg.start}
              data-judge-hl={seg.judge ? '1' : undefined}
              data-prior-focused={seg.focused ? '1' : undefined}
              style={{
                ...(seg.ann
                  ? annStyle(seg.ann)
                  : seg.pending
                    ? pendingStyle
                    : seg.suggestion
                      ? suggestionStyle
                      : seg.judge === 'pass'
                        ? judgePassStyle
                        : seg.judge === 'fail'
                          ? judgeFailStyle
                          : undefined),
                outline: seg.focused ? '2px solid var(--blue-500)' : undefined,
              }}
              title={
                seg.ann
                  ? seg.ann.body
                  : seg.pending
                    ? composer
                      ? 'Selected — write the comment'
                      : suggest
                        ? 'Selected — write the replacement'
                        : 'Selected — type to suggest, ⌘⇧M to comment'
                    : seg.suggestion
                      ? 'Pending suggestion'
                      : seg.judge
                        ? `Judge: ${seg.judge}`
                        : undefined
              }
            >
              {seg.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );

  const paneHead: React.CSSProperties = {
    padding: '8px 16px',
    fontSize: 12,
    color: 'var(--slate-500)',
    background: '#fff',
    borderBottom: '1px solid var(--border)',
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
          href={queueListHref(queueRef(request))}
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
        {remainingWork && <RemainingWorkChip work={remainingWork} />}
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
        {splitAvailable && (
          splitOpen ? (
            <button
              type="button"
              onClick={() => setCurrentOnly(true)}
              className="ds-btn ds-btn--ghost"
              style={{ height: 36 }}
            >
              Current only
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCurrentOnly(false)}
              className="ds-btn ds-btn--ghost"
              style={{ height: 36 }}
            >
              Show previous
            </button>
          )
        )}
        <div style={{ flex: 1 }} />
        {versionList.length > 1 && appliedSuggestions.length === 0 && (
          <select
            title="Accept version"
            value={acceptVersionId}
            onChange={(e) => setAcceptVersionId(e.target.value)}
            className="ds-select-trigger"
            style={{ width: 160, height: 36, fontSize: 12 }}
          >
            {versionList.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.number} · {v.author || (v.hash ? v.hash.slice(0, 8) : 'version')}
              </option>
            ))}
          </select>
        )}
        {gateInfo?.blocked && !shouldReject && !sealingPrior && (
          <span
            title={gateInfo.reasons.join(' · ')}
            style={{ fontSize: 12, color: 'var(--slate-500)', maxWidth: 260 }}
          >
            {gateInfo.reasons[0]}
          </span>
        )}
        <button
          type="button"
          data-testid="verdict-button"
          onClick={fireMainVerdict}
          className="ds-btn"
          disabled={verdictDisabled}
          title={verdictTitle}
          style={{
            background: showSave
              ? 'var(--blue-600)'
              : showAccept
                ? 'var(--green-600)'
                : 'var(--red-600)',
            color: '#fff',
            border: `1px solid ${
              showSave ? 'var(--blue-600)' : showAccept ? 'var(--green-600)' : 'var(--red-600)'
            }`,
          }}
        >
          {showSave ? 'Save manual edits' : showAccept ? 'Accept' : 'Reject'}
          <span style={kbdSolid}>⌘↵</span>
        </button>
      </div>

      {sealingPrior && (
        <div
          style={{
            background: 'var(--amber-50)',
            borderBottom: '1px solid var(--amber-500)',
            color: 'var(--amber-900)',
            padding: '8px 24px',
            fontSize: 13,
          }}
        >
          Sealing version {versionList.find((v) => v.id === acceptVersionId)?.number} ·{' '}
          {versionList.find((v) => v.id === acceptVersionId)?.hash}
        </div>
      )}
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

          {splitOpen ? (
            <>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  borderRight: '1px solid var(--border)',
                }}
              >
                <div style={paneHead}>Previous · round {request.round - 1}</div>
                <ArtifactPane side="left" paneRef={leftRef} style={{ padding: '28px 40px 80px' }}>
                  <MarkedText
                    content={previousContentMd ?? ''}
                    marks={previousMarks}
                    fontSize={15}
                    maxWidth={760}
                  />
                </ArtifactPane>
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={paneHead}>Current · round {request.round}</div>
                <ArtifactPane side="right" paneRef={artifactRef} onMouseUp={onCurrentMouseUp}>
                  {currentParagraphs}
                </ArtifactPane>
              </div>
            </>
          ) : (
            <ArtifactPane paneRef={artifactRef} onMouseUp={onCurrentMouseUp}>
              {currentParagraphs}
            </ArtifactPane>
          )}
        </div>

        {/* Right: review rail */}
        {rightOpen ? (
          <div
            ref={railRef}
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
                <span style={sectionHead}>Criteria</span>
                <div style={{ flex: 1 }} />
                {judgeStatus && (
                  <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>judge {judgeStatus}</span>
                )}
                {rerunAllowed &&
                  (confirmRerun ? (
                    <>
                      <button
                        type="button"
                        className="ds-btn ds-btn--ghost"
                        style={{ height: 28, fontSize: 12 }}
                        onClick={() => {
                          setConfirmRerun(false);
                          setError(null);
                          startTransition(async () => {
                            const res = await rerunJudgeAction({
                              requestId: request.id,
                              versionId,
                            });
                            if (!res.ok) {
                              setError(res.error);
                              return;
                            }
                            router.refresh();
                          });
                        }}
                      >
                        Confirm rerun
                      </button>
                      <button
                        type="button"
                        className="ds-btn ds-btn--ghost"
                        style={{ height: 28, fontSize: 12 }}
                        onClick={() => setConfirmRerun(false)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ds-btn ds-btn--ghost"
                      style={{ height: 28, fontSize: 12 }}
                      disabled={rerunBusy}
                      title={
                        rerunBusy
                          ? 'Judge is already running'
                          : 'Run the machine judge again on this version'
                      }
                      onClick={() => setConfirmRerun(true)}
                    >
                      Rerun judge
                    </button>
                  ))}
                <span
                  style={{ fontSize: 12, color: 'var(--slate-500)' }}
                  title="Policy version in effect for this review — stamped into the signed event"
                >
                  {request.policyLabel}
                </span>
              </div>
              {scoredCriteria.map((c) => {
                const hasAi = Boolean(c.finding) || c.score != null;
                const expanded = !hasAi || Boolean(openIds[c.id]);
                const focused = focusedCriterionId === c.id;
                const borderColor =
                  c.verdict === 'pass'
                    ? 'var(--green-500)'
                    : c.verdict === 'fail'
                      ? 'var(--red-500)'
                      : 'var(--border)';
                const scoreColor =
                  c.finding?.passed === true
                    ? 'var(--green-900)'
                    : c.finding?.passed === false
                      ? 'var(--red-900)'
                      : 'var(--slate-500)';
                return (
                  <div
                    key={c.id}
                    ref={(el) => {
                      cardRefs.current[c.id] = el;
                    }}
                    data-testid={`criterion-${c.id}`}
                    data-criterion-card={c.id}
                    tabIndex={0}
                    onFocus={() => {
                      setFocusedCriterionId(c.id);
                      showFinding(c);
                    }}
                    onMouseEnter={() => showFinding(c)}
                    onMouseLeave={() => {
                      if (focusedCriterionId === c.id) showFinding(c);
                      else {
                        const focusedRow = scoredCriteria.find((row) => row.id === focusedCriterionId);
                        showFinding(focusedRow);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.repeat) return;
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        setCriterion(c.id, 'pass');
                        focusNextCriterion(c.id);
                      }
                      if (e.key === 'Backspace') {
                        e.preventDefault();
                        setCriterion(c.id, 'fail');
                        focusNextCriterion(c.id);
                      }
                    }}
                    style={{
                      border: `1px solid ${focused ? 'var(--blue-500)' : borderColor}`,
                      boxShadow: focused ? '0 0 0 2px color-mix(in srgb, var(--blue-500) 25%, transparent)' : undefined,
                      borderRadius: 8,
                      padding: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      outline: 'none',
                      background: focused ? 'var(--slate-50)' : '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {hasAi && (
                        <button
                          type="button"
                          tabIndex={-1}
                          title={expanded ? 'Hide criterion detail' : 'Show criterion detail'}
                          aria-expanded={expanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenIds((prev) => ({ ...prev, [c.id]: !prev[c.id] }));
                          }}
                          style={{
                            width: 22,
                            height: 22,
                            flex: 'none',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            background: '#fff',
                            cursor: 'pointer',
                            color: 'var(--slate-600)',
                            fontSize: 11,
                            lineHeight: 1,
                          }}
                        >
                          {expanded ? '▾' : '▸'}
                        </button>
                      )}
                      <span
                        style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, flex: 1, minWidth: 0 }}
                        title={c.description ?? ''}
                      >
                        {c.title}
                      </span>
                      {(localVerdict[c.id] || c.source === 'human') && (
                        <span style={{ fontSize: 10, color: 'var(--slate-500)' }}>you</span>
                      )}
                      {hasAi && (
                        <span
                          data-testid={`confidence-${c.id}`}
                          title="Model confidence that this criterion passed"
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: scoreColor,
                            fontVariantNumeric: 'tabular-nums',
                            flex: 'none',
                          }}
                        >
                          {formatScore(c.score)}
                        </span>
                      )}
                    </div>
                    {expanded && (
                      <>
                        {hasAi && c.finding?.note && (
                          <span style={{ fontSize: 12, color: 'var(--slate-600)', lineHeight: 1.45 }}>
                            {c.finding.note}
                          </span>
                        )}
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
                                tabIndex={-1}
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
                      </>
                    )}
                  </div>
                );
              })}

              {priorItems.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px' }}>
                    <span style={sectionHead}>Prior findings</span>
                  </div>
                  <PriorFindingsList
                    items={priorItems}
                    focusId={focusFindingId}
                    onFocus={setFocusFindingId}
                    retireFor={retireFor}
                    retireReason={retireReason}
                    onRetireReasonChange={setRetireReason}
                    reasonRef={reasonRef}
                    onResolved={(id) =>
                      startTransition(async () => {
                        await confirmResolutionAction(request.id, id, versionId);
                        router.refresh();
                      })
                    }
                    onPersists={(id) =>
                      startTransition(async () => {
                        await markPersistingAction(request.id, id, versionId);
                        router.refresh();
                      })
                    }
                    onOpenRepin={(id) => openFollowUp('repin', id)}
                    onOpenRetire={(id) => openFollowUp('retire', id)}
                    onCommitRetire={commitRetire}
                    onCancelFollowUp={() => {
                      setRetireFor(null);
                      setRetireReason('');
                    }}
                  />
                </>
              )}

              {(pendingSuggestions.length > 0 || appliedSuggestions.length > 0 || suggest) && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px' }}>
                    <span style={sectionHead}>Suggestions</span>
                  </div>
                  {suggest && (
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
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue-900)' }}>
                        Replace — “{suggest.phrase}”
                      </span>
                      <textarea
                        ref={suggestInputRef}
                        value={suggestText}
                        onChange={(e) => setSuggestText(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault();
                            saveSuggestion();
                          }
                          if (e.key === 'Escape') setSuggest(null);
                        }}
                        rows={3}
                        placeholder="Replacement text"
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
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button
                          type="button"
                          onClick={saveSuggestion}
                          className="ds-btn ds-btn--default ds-btn--sm"
                        >
                          Suggest
                        </button>
                        <button
                          type="button"
                          onClick={() => setSuggest(null)}
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
                      </div>
                    </div>
                  )}
                  <SuggestionList
                    items={suggestions}
                    onAccept={(id) =>
                      startTransition(async () => {
                        await acceptSuggestionAction(request.id, id);
                        router.refresh();
                      })
                    }
                    onReject={(id) =>
                      startTransition(async () => {
                        await rejectSuggestionAction(request.id, id);
                        router.refresh();
                      })
                    }
                  />
                </>
              )}

              {liveSel && !composer && !suggest && (
                <div
                  style={{
                    border: '1px solid var(--amber-500)',
                    background: 'var(--amber-50)',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--amber-900)' }}>
                    Selected — “{liveSel.phrase}”
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                    Type to replace · Backspace to delete · ⌘⇧M to comment
                  </span>
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    onClick={() => openCommentOn(liveSel)}
                  >
                    Comment
                  </button>
                </div>
              )}

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
                  {roundComments.length}
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
                      onClick={() => {
                        setComposer(null);
                        setCoText('');
                        coTextRef.current = '';
                      }}
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
                      if (e.key === 'Escape') {
                        setComposer(null);
                        setCoText('');
                        coTextRef.current = '';
                      }
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
                      onClick={() => {
                        setComposer(null);
                        setCoText('');
                        coTextRef.current = '';
                      }}
                      style={{ color: 'var(--slate-500)', fontSize: 12, cursor: 'pointer', background: 'none', border: 'none' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {roundComments.length === 0 && !composer && (
                <span style={{ fontSize: 12, color: 'var(--slate-400)', lineHeight: 1.5 }}>
                  No comments yet — select a range in the artifact.
                </span>
              )}

              {roundComments.map((cm) => (
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
