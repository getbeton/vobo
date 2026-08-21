'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { archiveRequestsAction, claimAction, releaseAction } from '@/lib/actions/review';

/**
 * Reviewer Queue — verbatim port of the prototype's queue screen:
 * ranked list caption tooltip, Next-up card (Proceed ↵), rows with SLA badge /
 * version badge ("v2 returned — N persisting", loud) / sticky chip / lease
 * note (dimmed, never hidden), "Queue clear" empty state.
 * Keys: J/K focus · Enter/N claim · R release own lease.
 *
 * Operators and admins also get selection and bulk archive (VOBO-224). A
 * reviewer sees no checkbox: archive takes work off the board without a
 * verdict, so it belongs to whoever owns the queue.
 */

export interface QueueRowData {
  id: string;
  title: string;
  round: number;
  status: string;
  slaDueAt: string | null;
  priority: number;
  sticky: boolean;
  persisting: number;
  rankRationale: string;
  lease: { mine: boolean; expiresAt: string } | null;
}

function slaBadge(slaDueAt: string | null): { text: string; style: React.CSSProperties } {
  const base: React.CSSProperties = {
    fontSize: 11,
    borderRadius: 9999,
    padding: '1px 8px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
  if (!slaDueAt) return { text: 'no SLA', style: { ...base, background: 'var(--slate-100)', color: 'var(--slate-500)' } };
  const ms = new Date(slaDueAt).getTime() - Date.now();
  const h = Math.floor(Math.abs(ms) / 3_600_000);
  const m = Math.floor((Math.abs(ms) % 3_600_000) / 60_000);
  const label = ms < 0 ? `overdue ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (ms < 0) return { text: label, style: { ...base, background: 'var(--red-100)', color: 'var(--red-900)' } };
  if (ms < 4 * 3_600_000)
    return { text: label, style: { ...base, background: 'var(--amber-100)', color: 'var(--amber-900)' } };
  return { text: label, style: { ...base, background: 'var(--green-100)', color: 'var(--green-900)' } };
}

function versionBadge(round: number, persisting: number) {
  if (round <= 1)
    return (
      <span
        style={{
          fontSize: 11,
          color: 'var(--slate-500)',
          background: 'var(--slate-100)',
          borderRadius: 9999,
          padding: '1px 8px',
          whiteSpace: 'nowrap',
        }}
      >
        v1
      </span>
    );
  const loud = persisting > 0;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: loud ? 'var(--red-900)' : 'var(--slate-600)',
        background: loud ? 'var(--red-100)' : 'var(--slate-100)',
        borderRadius: 9999,
        padding: '1px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {loud ? `v${round} returned — ${persisting} persisting` : `v${round} returned`}
    </span>
  );
}

/**
 * Why a queue could not be shown. VOBO-204: one flag said "no queue" for three
 * different situations, and the copy asserted the pipeline registers queues
 * over the API. It does not — `createReview` answers 404 for an unknown slug
 * and there is no queue-create endpoint. Each case now says what is true.
 */
export interface QueueMiss {
  kind: 'no_projects' | 'no_queues' | 'queue_not_found' | 'project_not_found';
  /** The slug the reader asked for, when they asked for one. */
  askedFor?: string | null;
  /** The project the reader asked for, when they asked for one. */
  askedProject?: string | null;
  /** The project that was selected, for the admin link. */
  projectSlug?: string | null;
  projectName?: string | null;
  /** Every queue in the workspace, so the reader can go to a real one. */
  available: Array<{ projectSlug: string; projectName: string; queueSlug: string }>;
  environment: 'production' | 'test';
}

export function QueueMissScreen({ miss }: { miss: QueueMiss }) {
  const links = miss.available.map((q) => (
    <Link
      key={`${q.projectSlug}/${q.queueSlug}`}
      href={`/queue?project=${encodeURIComponent(q.projectSlug)}&queue=${encodeURIComponent(
        q.queueSlug
      )}&env=${miss.environment}`}
      style={{
        fontSize: 13,
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '6px 10px',
        textDecoration: 'none',
        color: 'var(--slate-700)',
        background: '#fff',
      }}
    >
      {q.projectName} · {q.queueSlug}
    </Link>
  ));

  let title: string;
  let body: React.ReactNode;

  if (miss.kind === 'project_not_found') {
    title = 'That project is not in this workspace';
    body = (
      <>
        No project has the slug <code>{miss.askedProject}</code>.
      </>
    );
  } else if (miss.kind === 'queue_not_found') {
    title = 'That queue is not in this workspace';
    body = (
      <>
        No queue has the slug <code>{miss.askedFor}</code> in the{' '}
        <strong>{miss.environment}</strong> environment.
      </>
    );
  } else if (miss.kind === 'no_projects') {
    title = 'This workspace has no projects';
    body = <>Create a project before you review anything.</>;
  } else {
    title = `${miss.projectName ?? 'This project'} has no queues`;
    body = (
      <>
        An operator or the seed script creates a queue. The pipeline does not: a review request for
        an unknown queue gets <code>404 queue_not_found</code>.
      </>
    );
  }

  return (
    <div style={{ padding: '28px 32px' }}>
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
          maxWidth: 880,
          margin: '0 auto',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
        <span style={{ fontSize: 13, color: 'var(--slate-500)', textAlign: 'center' }}>{body}</span>
        {links.length > 0 && (
          <>
            <span style={{ fontSize: 12, color: 'var(--slate-400)', marginTop: 6 }}>
              These queues exist:
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {links}
            </div>
          </>
        )}
        {miss.projectSlug && (
          <Link
            href={`/admin/projects/${miss.projectSlug}`}
            style={{ fontSize: 12, color: 'var(--blue-700)', marginTop: 6 }}
          >
            Open the project page
          </Link>
        )}
      </div>
    </div>
  );
}

export function QueueScreen({
  rows,
  nextUp,
  miss,
  canArchive = false,
  archivedHref = '/queue/archived',
  failingHref = null,
}: {
  rows: QueueRowData[];
  nextUp: QueueRowData | null;
  miss: QueueMiss | null;
  /** Operator or admin. Reviewers never see the selection controls. */
  canArchive?: boolean;
  /** Where the operator's undo list lives, with the current queue selected. */
  archivedHref?: string;
  /** Operator-only. Always visible when set — not nested in the bulk bar. */
  failingHref?: string | null;
}) {
  const router = useRouter();
  const [focusIdx, setFocusIdx] = useState(0);
  const [tipRank, setTipRank] = useState(false);
  const [tipNext, setTipNext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Anchor for shift-click ranges, same behaviour as Apollo's list.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  const toggleRow = (index: number, shiftKey: boolean) => {
    const next = new Set(selected);
    if (shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      // A shift-click extends the selection; it never clears what is already on.
      for (let i = from; i <= to; i++) next.add(rows[i].id);
    } else {
      const id = rows[index].id;
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setAnchor(index);
    }
    setSelected(next);
  };

  const archiveSelected = () => {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    setError(null);
    startTransition(async () => {
      const res = await archiveRequestsAction(ids);
      if (!res.ok) {
        setError(res.error);
        setConfirmArchive(false);
        return;
      }
      setConfirmArchive(false);
      setSelected(new Set());
      setAnchor(null);
      router.refresh();
    });
  };

  const openOrClaim = (row: QueueRowData) => {
    setError(null);
    startTransition(async () => {
      if (row.lease?.mine || row.status === 'claimed') {
        router.push(`/review/${row.id}`);
        return;
      }
      const res = await claimAction(row.id);
      if (res.ok) {
        router.push(`/review/${row.id}`);
      } else if (res.code === 'claim_race' || res.code === 'not_claimable') {
        setError('Claimed by another reviewer just now');
        setFocusIdx((i) => Math.min(i + 1, rows.length - 1));
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea')) return;
      if (e.key === 'j' || e.key === 'J') setFocusIdx((i) => Math.min(i + 1, rows.length - 1));
      if (e.key === 'k' || e.key === 'K') setFocusIdx((i) => Math.max(i - 1, 0));
      if (e.key === 'Enter') {
        const row = rows[focusIdx];
        if (row) openOrClaim(row);
      }
      if ((e.key === 'n' || e.key === 'N') && nextUp) openOrClaim(nextUp);
      if ((e.key === 'r' || e.key === 'R')) {
        const row = rows[focusIdx];
        if (row?.lease?.mine) {
          startTransition(async () => {
            await releaseAction(row.id);
            router.refresh();
          });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, focusIdx, nextUp]);

  if (miss) return <QueueMissScreen miss={miss} />;

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Reviewer queue</span>
          {failingHref && (
            <Link
              href={failingHref}
              style={{
                fontSize: 13,
                color: 'var(--blue-700)',
                textDecoration: 'none',
                fontWeight: 500,
                marginLeft: 4,
              }}
            >
              Failing requests
            </Link>
          )}
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <span
              onMouseEnter={() => setTipRank(true)}
              onMouseLeave={() => setTipRank(false)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                border: '1px solid var(--border)',
                borderRadius: 9999,
                fontSize: 11,
                color: 'var(--slate-500)',
                cursor: 'default',
              }}
            >
              ?
            </span>
            {tipRank && (
              <div
                style={{
                  position: 'absolute',
                  top: 26,
                  left: -10,
                  width: 320,
                  background: 'var(--slate-900)',
                  color: 'var(--slate-50)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12,
                  lineHeight: 1.55,
                  zIndex: 50,
                  boxShadow: 'var(--shadow-md)',
                }}
              >
                Ranked by queue policy — SLA first, then priority, then judge confidence ascending.
                Reviewers never configure sorting; rank is the recommendation.
              </div>
            )}
          </span>
          {canArchive && (
            <Link
              href={archivedHref}
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: 'var(--blue-700)',
                textDecoration: 'none',
              }}
            >
              Archived
            </Link>
          )}
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

        {nextUp && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--blue-700)',
                  textTransform: 'uppercase',
                  letterSpacing: '.05em',
                }}
              >
                Next up
              </span>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <span
                  onMouseEnter={() => setTipNext(true)}
                  onMouseLeave={() => setTipNext(false)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    border: '1px solid var(--border)',
                    borderRadius: 9999,
                    fontSize: 10,
                    color: 'var(--slate-500)',
                    cursor: 'default',
                  }}
                >
                  ?
                </span>
                {tipNext && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 24,
                      left: -10,
                      width: 300,
                      background: 'var(--slate-900)',
                      color: 'var(--slate-50)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      fontSize: 12,
                      lineHeight: 1.55,
                      zIndex: 50,
                      boxShadow: 'var(--shadow-md)',
                    }}
                  >
                    {nextUp.rankRationale}
                  </div>
                )}
              </span>
            </div>
            <div
              style={{
                border: '1px solid var(--blue-200)',
                background: '#fff',
                borderRadius: 12,
                padding: '16px 20px',
                boxShadow: 'var(--shadow-sm)',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={slaBadge(nextUp.slaDueAt).style}>{slaBadge(nextUp.slaDueAt).text}</span>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {nextUp.title}
                  </span>
                  {versionBadge(nextUp.round, nextUp.persisting)}
                  {nextUp.sticky && (
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--blue-700)',
                        background: 'var(--blue-50)',
                        borderRadius: 9999,
                        padding: '1px 8px',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      returning to you
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => openOrClaim(nextUp)}
                className="ds-btn ds-btn--default"
                style={{ minWidth: 130 }}
              >
                Proceed
                <span
                  style={{
                    fontSize: 11,
                    background: 'rgba(255,255,255,.22)',
                    borderRadius: 5,
                    padding: '1px 6px',
                  }}
                >
                  ↵
                </span>
              </button>
            </div>
          </>
        )}

        {canArchive && rows.length > 0 && (
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
                if (el) el.indeterminate = selected.size > 0 && !allSelected;
              }}
              onChange={() => {
                setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
                setAnchor(null);
              }}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {selected.size === 0 ? (
              <>
                <span style={{ color: 'var(--slate-500)' }}>
                  Select requests to archive them. Shift-click picks a range.
                </span>
                <div style={{ flex: 1 }} />
                <Link
                  href={archivedHref}
                  style={{ fontSize: 12, color: 'var(--blue-700)', textDecoration: 'none' }}
                >
                  Archived
                </Link>
              </>
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
                  Archive {selected.size}
                </button>
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((row, i) => {
            const heldByOther = row.lease && !row.lease.mine;
            const leaseMinutes = row.lease
              ? Math.max(0, Math.round((new Date(row.lease.expiresAt).getTime() - Date.now()) / 60000))
              : 0;
            return (
              <div
                key={row.id}
                onClick={() => openOrClaim(row)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: i === focusIdx ? '1px solid var(--blue-400)' : '1px solid var(--border)',
                  background: selected.has(row.id) ? 'var(--blue-50)' : '#fff',
                  borderRadius: 10,
                  padding: '12px 16px',
                  cursor: 'pointer',
                  opacity: heldByOther ? 0.55 : 1,
                }}
              >
                {canArchive && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selected.has(row.id)}
                    onClick={(e) => {
                      // The row itself opens the request; a checkbox must not.
                      e.stopPropagation();
                      toggleRow(i, e.shiftKey);
                    }}
                    onChange={() => {}}
                    style={{ cursor: 'pointer', width: 15, height: 15, flex: 'none' }}
                  />
                )}
                <span style={slaBadge(row.slaDueAt).style}>{slaBadge(row.slaDueAt).text}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
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
                  {versionBadge(row.round, row.persisting)}
                  {row.sticky && (
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--blue-700)',
                        background: 'var(--blue-50)',
                        borderRadius: 9999,
                        padding: '1px 8px',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      returning to you
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: 'var(--slate-500)', whiteSpace: 'nowrap' }}>
                  {row.lease
                    ? row.lease.mine
                      ? `your lease · ${leaseMinutes}m left`
                      : `in review · lease ${leaseMinutes}m left`
                    : `P${row.priority}`}
                </span>
              </div>
            );
          })}
        </div>

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
                Archive {selected.size} request{selected.size > 1 ? 's' : ''}?
              </span>
              <span style={{ fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.55 }}>
                They leave this queue and the pipeline pull without a verdict. Each one records a
                signed <code>request.archived</code> event with your name, so the chain still tells
                the whole story. Nothing is deleted.
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
                  disabled={isPending}
                  className="ds-btn ds-btn--default"
                  style={{ padding: '8px 16px', fontSize: 13, opacity: isPending ? 0.6 : 1 }}
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        )}

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
            <span style={{ fontWeight: 600, fontSize: 15 }}>Queue clear</span>
            <span style={{ fontSize: 13, color: 'var(--slate-500)' }}>
              Nothing awaiting review in this queue · switch queues in the breadcrumb
            </span>
            {canArchive && (
              <Link
                href={archivedHref}
                style={{ fontSize: 12, color: 'var(--blue-700)', marginTop: 6 }}
              >
                Archived
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
