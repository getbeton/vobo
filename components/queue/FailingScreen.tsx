'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { archiveRequestsAction, exportFailingCsvAction } from '@/lib/actions/review';
import { QueueMiss, QueueMissScreen } from '@/components/queue/QueueScreen';

export interface FailingRowData {
  id: string;
  title: string;
  status: string;
  round: number;
  roundBudget: number;
  queueSlug: string;
  flaggedAt: string;
  lastDecisionKind: string | null;
  customerRequestId: string;
  archivedAt: string | null;
}

const statusChip: Record<string, { bg: string; fg: string }> = {
  accepted: { bg: 'var(--green-100)', fg: 'var(--green-900)' },
  rejected: { bg: 'var(--red-100)', fg: 'var(--red-900)' },
  escalated: { bg: 'var(--amber-100)', fg: 'var(--amber-900)' },
  open: { bg: 'var(--slate-100)', fg: 'var(--slate-600)' },
  claimed: { bg: 'var(--blue-100)', fg: 'var(--blue-900)' },
};

const STATUS_FILTERS = ['all', 'rejected', 'accepted', 'escalated', 'open', 'claimed'] as const;

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function FailingScreen({
  rows,
  queueId,
  queueHref,
  miss,
}: {
  rows: FailingRowData[];
  queueId: string | null;
  queueHref: string;
  miss: QueueMiss | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titleQuery, setTitleQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');

  if (miss) return <QueueMissScreen miss={miss} />;

  const q = titleQuery.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (q && !r.title.toLowerCase().includes(q) && !r.customerRequestId.toLowerCase().includes(q))
      return false;
    return true;
  });

  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const selectedVisible = visible.filter((r) => selected.has(r.id)).map((r) => r.id);
  const exportIds = selectedVisible.length > 0 ? selectedVisible : visible.map((r) => r.id);

  const toggleRow = (index: number, shiftKey: boolean) => {
    const next = new Set(selected);
    if (shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = from; i <= to; i++) next.add(visible[i].id);
    } else {
      const id = visible[index].id;
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setAnchor(index);
    }
    setSelected(next);
  };

  const exportCsv = () => {
    if (!queueId || exportIds.length === 0) return;
    setError(null);
    startTransition(async () => {
      const res = await exportFailingCsvAction(queueId, exportIds);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.data?.csv) downloadCsv(res.data.csv, res.data.filename ?? 'failing-requests.csv');
    });
  };

  const archiveSelected = () => {
    if (selectedVisible.length === 0) return;
    setError(null);
    startTransition(async () => {
      const res = await archiveRequestsAction(selectedVisible);
      if (!res.ok) setError(res.error);
      setConfirmArchive(false);
      setSelected(new Set());
      setAnchor(null);
      router.refresh();
    });
  };

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Failing requests</span>
          <Link href={queueHref} style={{ fontSize: 13, color: 'var(--blue-700)', textDecoration: 'none' }}>
            Back to queue
          </Link>
        </div>
        <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>
          These requests used the last policy round.
        </span>

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

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            value={titleQuery}
            onChange={(e) => {
              setTitleQuery(e.target.value);
              setAnchor(null);
            }}
            placeholder="Filter by title or id"
            aria-label="Filter by title or customer request id"
            style={{
              flex: 1,
              minWidth: 180,
              border: '1px solid var(--input)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as (typeof STATUS_FILTERS)[number]);
              setAnchor(null);
            }}
            aria-label="Filter by status"
            className="ds-select-trigger"
            style={{ width: 160, height: 36, fontSize: 13 }}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All statuses' : s}
              </option>
            ))}
          </select>
        </div>

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
              aria-label="Select every request on this page"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = selectedVisible.length > 0 && !allSelected;
              }}
              onChange={() => {
                setSelected(allSelected ? new Set() : new Set(visible.map((r) => r.id)));
                setAnchor(null);
              }}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {selected.size === 0 ? (
              <span style={{ color: 'var(--slate-500)' }}>
                Select requests to export or archive them. Shift-click picks a range.
              </span>
            ) : (
              <>
                <span style={{ fontWeight: 500 }}>
                  {selected.size} selected of {visible.length}
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
              </>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={exportCsv}
              disabled={exportIds.length === 0}
              className="ds-btn ds-btn--sm"
              style={{
                border: '1px solid var(--border)',
                background: '#fff',
                borderRadius: 8,
                padding: '6px 12px',
                cursor: exportIds.length === 0 ? 'default' : 'pointer',
                fontWeight: 500,
              }}
            >
              Export CSV
            </button>
            {selectedVisible.length > 0 && (
              <button
                type="button"
                onClick={() => setConfirmArchive(true)}
                className="ds-btn ds-btn--sm"
                style={{
                  border: '1px solid var(--border)',
                  background: '#fff',
                  borderRadius: 8,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                Archive {selectedVisible.length}
              </button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visible.map((row, i) => {
            const c = statusChip[row.status] ?? statusChip.open;
            const flagged = row.flaggedAt.slice(0, 16).replace('T', ' ');
            return (
              <Link
                key={row.id}
                href={`/requests/${row.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: '1px solid var(--border)',
                  background: selected.has(row.id) ? 'var(--blue-50)' : '#fff',
                  borderRadius: 10,
                  padding: '12px 16px',
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${row.title}`}
                  checked={selected.has(row.id)}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleRow(i, e.shiftKey);
                  }}
                  onChange={() => {}}
                  style={{ cursor: 'pointer', width: 15, height: 15, flex: 'none' }}
                />
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 9999,
                    padding: '1px 8px',
                    background: c.bg,
                    color: c.fg,
                  }}
                >
                  {row.status}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: 500,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {row.title}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>
                    round {row.round} of {row.roundBudget}
                    {row.lastDecisionKind ? ` · ${row.lastDecisionKind}` : ''}
                    {row.archivedAt ? ' · archived' : ''}
                  </span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--slate-400)', whiteSpace: 'nowrap' }}>
                  {flagged}
                </span>
              </Link>
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
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 15 }}>None in this queue</span>
            <span style={{ fontSize: 13, color: 'var(--slate-500)', textAlign: 'center' }}>
              A reject at the last policy round flags the request and lists it here.
            </span>
          </div>
        )}

        {rows.length > 0 && visible.length === 0 && (
          <div
            style={{
              border: '1px dashed var(--border)',
              borderRadius: 12,
              padding: 32,
              textAlign: 'center',
              background: '#fff',
              color: 'var(--slate-500)',
              fontSize: 13,
            }}
          >
            No request matches these filters.
          </div>
        )}

        {confirmArchive && (
          <div
            onClick={() => setConfirmArchive(false)}
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
                Archive {selectedVisible.length} request{selectedVisible.length > 1 ? 's' : ''}?
              </span>
              <span style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.55 }}>
                They leave the reviewer queue and the pipeline pull without a further verdict. Each
                one records a signed <code>request.archived</code> event. Nothing is deleted.
              </span>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setConfirmArchive(false)}
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
                  onClick={archiveSelected}
                  className="ds-btn ds-btn--default"
                  style={{ padding: '8px 16px', fontSize: 13 }}
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
