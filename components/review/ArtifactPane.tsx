'use client';

import { useEffect, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react';

/**
 * Shared scroll pane for the review artifact. Version compare and the
 * round-2+ workspace split both render previous | current through this, so
 * selection math (`data-seg-start`) and `data-side` stay one contract.
 */

export const artifactStateColors: Record<string, { bg: string; fg: string; border: string }> = {
  persisting: { bg: 'var(--red-100)', fg: 'var(--red-900)', border: 'var(--red-500)' },
  resolved: { bg: 'var(--green-100)', fg: 'var(--green-900)', border: 'var(--green-500)' },
  orphaned: { bg: 'var(--amber-100)', fg: 'var(--amber-900)', border: 'var(--amber-500)' },
  repinned: { bg: 'var(--blue-100)', fg: 'var(--blue-900)', border: 'var(--blue-500)' },
  new: { bg: 'var(--blue-100)', fg: 'var(--blue-900)', border: 'var(--blue-500)' },
};

export type CompareMark = {
  start: number;
  end: number;
  state: string;
  low: boolean;
  focused: boolean;
};

export function segsFromMarks(content: string, marks: CompareMark[]) {
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  const segs: Array<{ text: string; start: number; mark: CompareMark | null }> = [];
  let pos = 0;
  for (const m of sorted) {
    if (m.start < pos || m.start >= content.length) continue;
    if (m.start > pos) segs.push({ text: content.slice(pos, m.start), start: pos, mark: null });
    const end = Math.min(m.end, content.length);
    segs.push({ text: content.slice(m.start, end), start: m.start, mark: m });
    pos = end;
  }
  if (pos < content.length) segs.push({ text: content.slice(pos), start: pos, mark: null });
  return segs;
}

export function MarkedText({
  content,
  marks,
  fontSize = 14.5,
  maxWidth = 700,
}: {
  content: string;
  marks: CompareMark[];
  fontSize?: number;
  maxWidth?: number;
}) {
  const segs = segsFromMarks(content, marks);
  return (
    <div
      style={{
        fontSize,
        lineHeight: 1.8,
        color: 'var(--slate-800)',
        whiteSpace: 'pre-wrap',
        maxWidth,
      }}
    >
      {segs.map((s) => {
        if (!s.mark)
          return (
            <span key={s.start} data-seg-start={s.start}>
              {s.text}
            </span>
          );
        const c = artifactStateColors[s.mark.state] ?? artifactStateColors.new;
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
  );
}

export function ArtifactPane({
  side,
  onMouseUp,
  paneRef,
  children,
  style,
}: {
  side?: 'left' | 'right';
  onMouseUp?: () => void;
  paneRef?: Ref<HTMLDivElement>;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      ref={paneRef}
      onMouseUp={onMouseUp}
      data-side={side}
      tabIndex={side === 'right' ? 0 : undefined}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        position: 'relative',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function useSyncScroll(
  leftRef: RefObject<HTMLDivElement | null>,
  rightRef: RefObject<HTMLDivElement | null>,
  enabled: boolean
) {
  useEffect(() => {
    if (!enabled) return;
    const l = leftRef.current;
    const r = rightRef.current;
    if (!l || !r) return;
    let syncing = false;
    const sync = (src: HTMLDivElement, dst: HTMLDivElement) => () => {
      if (syncing) return;
      syncing = true;
      const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
      dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
      requestAnimationFrame(() => {
        syncing = false;
      });
    };
    const onL = sync(l, r);
    const onR = sync(r, l);
    l.addEventListener('scroll', onL);
    r.addEventListener('scroll', onR);
    return () => {
      l.removeEventListener('scroll', onL);
      r.removeEventListener('scroll', onR);
    };
  }, [leftRef, rightRef, enabled]);
}
