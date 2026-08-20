'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { unarchiveRequestsAction } from '@/lib/actions/review';

/**
 * Archived requests for one queue, and the way back.
 *
 * Selection behaves exactly like the reviewer queue's: a header checkbox with
 * an indeterminate state, shift-click for a range, a count and a clear. Two
 * lists that select differently would be a worse product than one that reads
 * the same twice.
 */

export interface ArchivedRowData {
  id: string;
  title: string;
  customerRequestId: string;
  status: string;
  round: number;
  archivedAt: string;
}

const statusChip: Record<string, { bg: string; fg: string }> = {
  accepted: { bg: 'var(--green-100)', fg: 'var(--green-900)' },
  rejected: { bg: 'var(--red-100)', fg: 'var(--red-900)' },
  escalated: { bg: 'var(--amber-100)', fg: 'var(--amber-900)' },
  open: { bg: 'var(--slate-100)', fg: 'var(--slate-600)' },
  claimed: { bg: 'var(--blue-100)', fg: 'var(--blue-900)' },
};

export function ArchivedScreen({
  rows,
  queueSlug,
  projectSlug,
  environment,
  noQueue,
}: {
  rows: ArchivedRowData[];
  queueSlug: string;
  projectSlug: string;
  environment: 'production' | 'test';
  noQueue: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  const toggleRow = (index: number, shiftKey: boolean) => {
    const next = new Set(selected);
    if (shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = from; i <= to; i++) next.add(rows[i].id);
    } else {
      const id = rows[index].id;
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setAnchor(index);
    }
    setSelected(next);
  };

  const restore = () => {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    setError(null);
    startTransition(async () => {
      const res = await unarchiveRequestsAction(ids);
      if (!res.ok) setError(res.error);
      setConfirm(false);
      setSelected(new Set());
      setAnchor(null);
      router.refresh();
    });
  };

  const queueHref = `/queue?project=${encodeURIComponent(projectSlug)}&queue=${encodeURIComponent(
    queueSlug
  )}&env=${environment}`;

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Archived</span>
          <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>
            {queueSlug ? `${queueSlug} · ${environment}` : 'no queue selected'}
          </span>
          <div style={{ flex: 1 }} />
          <Link
            href={queueHref}
            style={{ fontSize: 13, color: 'var(--blue-700)', textDecoration: 'none', fontWeight: 500 }}
          >
            Back to the queue
          </Link>
        </div>

        {error && (
          <div
            style={{
              border: '1px solid var(--amber-500)',
              background: 'var(--amber-50)',
              color: 'var(--amber-900)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {rows.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 16px',
              border: '1px solid var(--border)',
              background: selected.size > 0 ? 'var(--blue-50)' : '#fff',
              borderRadius: 10,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              aria-label="Select every archived request"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && !allSelected;
              }}
              onChange={() => {
                setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
                setAnchor(null);
              }}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {selected.size === 0 ? (
              <span style={{ color: 'var(--slate-500)' }}>
                Select requests to put them back. Shift-click picks a range.
              </span>
            ) : (
              <>
                <span style={{ fontWeight: 500 }}>
                  {selected.size} selected of {rows.length}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(new Set());
                    setAnchor(null);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--slate-500)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setConfirm(true)}
                  style={{
                    border: '1px solid var(--border)',
                    background: '#fff',
                    borderRadius: 8,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontWeight: 500,
                    fontSize: 13,
                  }}
                >
                  Put back {selected.size}
                </button>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((row, i) => {
            const chip = statusChip[row.status] ?? statusChip.open;
            return (
              <div
                key={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: '1px solid var(--border)',
                  background: selected.has(row.id) ? 'var(--blue-50)' : '#fff',
                  borderRadius: 10,
                  padding: '12px 16px',
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${row.title}`}
                  checked={selected.has(row.id)}
                  onClick={(e) => toggleRow(i, e.shiftKey)}
                  onChange={() => {}}
                  style={{ cursor: 'pointer', width: 15, height: 15, flex: 'none' }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 9999,
                    padding: '1px 8px',
                    background: chip.bg,
                    color: chip.fg,
                  }}
                >
                  {row.status}
                </span>
                <span
                  style={{
                    fontWeight: 500,
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {row.title}
                </span>
                <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>round {row.round}</span>
                <span style={{ fontSize: 12, color: 'var(--slate-400)' }}>
                  {row.archivedAt.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            );
          })}
        </div>

        {rows.length === 0 && (
          <div
            style={{
              border: '1px dashed var(--border)',
              borderRadius: 12,
              padding: 48,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              background: '#fff',
              textAlign: 'center',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 15 }}>
              {noQueue ? 'That queue is not in this workspace' : 'Nothing archived here'}
            </span>
            <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>
              {noQueue
                ? 'Pick a queue from the breadcrumb.'
                : 'Archived requests appear here, and an operator can put them back.'}
            </span>
          </div>
        )}

        {confirm && (
          <div
            onClick={() => setConfirm(false)}
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
                padding: 22,
                width: 460,
                maxWidth: '92vw',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 15 }}>
                Put {selected.size} request{selected.size > 1 ? 's' : ''} back?
              </span>
              <span style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.55 }}>
                Each returns with the status it held before it was archived. An open request goes
                back to the queue; a rejected one goes back to the pipeline&rsquo;s awaiting-version
                list. Each records a signed <code>request.unarchived</code> event with your name.
              </span>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setConfirm(false)}
                  style={{
                    border: '1px solid var(--border)',
                    background: '#fff',
                    borderRadius: 8,
                    padding: '8px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={restore}
                  className="ds-btn ds-btn--default"
                  style={{ padding: '8px 16px', fontSize: 13 }}
                >
                  Put back
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
