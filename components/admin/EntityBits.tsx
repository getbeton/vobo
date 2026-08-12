'use client';

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/actions/review';

/**
 * Shared pieces of the entity pages, ported verbatim from
 * design/vobo-review-station.dc.html (Workspace / Project / Queue screens):
 * the five-stat strip, the inline dropdown settings row, and the members card.
 */

export function StatStrip({
  stats,
  note,
}: {
  stats: Array<{ v: string; l: string; hot?: boolean }>;
  note?: string | null;
}) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          background: '#fff',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {stats.map((s) => (
          <div
            key={s.l}
            style={{
              flex: 1,
              padding: '16px 20px',
              borderRight: '1px solid var(--slate-100)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <span
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: s.hot ? 'var(--blue-700)' : 'var(--slate-900)',
              }}
            >
              {s.v}
            </span>
            <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>{s.l}</span>
          </div>
        ))}
      </div>
      {note && (
        <span style={{ fontSize: 12, color: 'var(--slate-400)', marginTop: -8 }}>{note}</span>
      )}
    </>
  );
}

const menuItem = (selected: boolean): React.CSSProperties => ({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  padding: '7px 9px',
  borderRadius: 6,
  fontSize: 13,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  color: selected ? 'var(--slate-950)' : 'var(--slate-800)',
  width: '100%',
});

export interface DropdownItem {
  label: string;
  selected: boolean;
  patch: Record<string, unknown>;
}

/** A settings row: label on the left, value as a dropdown (or plain text). */
export function SettingRow({
  label,
  value,
  canEdit,
  items,
  apply,
  width = 200,
}: {
  label: string;
  value: string;
  canEdit: boolean;
  items?: DropdownItem[];
  apply?: (patch: Record<string, unknown>) => Promise<ActionResult>;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderTop: '1px solid var(--slate-100)',
        paddingTop: 10,
      }}
    >
      <span style={{ flex: 1, fontSize: 13, color: 'var(--slate-700)' }}>
        {label}
        {err && (
          <span style={{ display: 'block', fontSize: 11, color: 'var(--red-600)' }}>{err}</span>
        )}
      </span>
      {canEdit && items && apply ? (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            disabled={pending}
            style={{
              fontSize: 12,
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 10px',
              color: 'var(--slate-600)',
              cursor: pending ? 'progress' : 'pointer',
              background: '#fff',
            }}
          >
            {value} ▾
          </button>
          {open && (
            <div
              style={{
                position: 'absolute',
                top: 30,
                right: 0,
                background: '#fff',
                border: '1px solid var(--border)',
                borderRadius: 8,
                boxShadow: 'var(--shadow-md)',
                padding: 4,
                display: 'flex',
                flexDirection: 'column',
                minWidth: width,
                zIndex: 60,
              }}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  style={menuItem(it.selected)}
                  onClick={() => {
                    setOpen(false);
                    setErr(null);
                    start(async () => {
                      const res = await apply(it.patch);
                      if (!res.ok) setErr(res.error);
                    });
                  }}
                >
                  <span style={{ whiteSpace: 'nowrap' }}>{it.label}</span>
                  <span
                    style={{
                      visibility: it.selected ? 'visible' : 'hidden',
                      color: 'var(--blue-600)',
                    }}
                  >
                    ✓
                  </span>
                </button>
              ))}
            </div>
          )}
        </span>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--slate-600)' }}>{value}</span>
      )}
    </div>
  );
}

export interface MemberRow {
  id: number;
  init: string;
  name: string;
  email: string;
  role: string;
  self: boolean;
}

const ROLES = ['admin', 'operator', 'reviewer'] as const;

export function MembersCard({
  members,
  note,
  canEdit,
  workspaceId,
  setRole,
  remove,
  invite,
}: {
  members: MemberRow[];
  note: string;
  canEdit: boolean;
  workspaceId: number;
  setRole: (memberId: number, role: string) => Promise<ActionResult>;
  remove: (memberId: number) => Promise<ActionResult>;
  invite: (workspaceId: number, email: string, role?: string) => Promise<ActionResult>;
}) {
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Members</span>
        <span style={{ fontSize: 12, color: 'var(--slate-500)' }}>{note}</span>
      </div>

      {members.map((m) => (
        <div
          key={m.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            borderTop: '1px solid var(--slate-100)',
            paddingTop: 10,
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 9999,
              background: 'var(--blue-50)',
              color: 'var(--blue-700)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 600,
              flex: 'none',
            }}
          >
            {m.init}
          </span>
          <span
            style={{
              flex: 1,
              fontSize: 13,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {m.name}
            <span style={{ color: 'var(--slate-400)' }}> · {m.email}</span>
          </span>
          {canEdit ? (
            <>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <button
                  type="button"
                  onClick={() => setOpenFor((v) => (v === m.id ? null : m.id))}
                  style={{
                    fontSize: 12,
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    color: 'var(--slate-600)',
                    cursor: 'pointer',
                    background: '#fff',
                  }}
                >
                  {m.role} ▾
                </button>
                {openFor === m.id && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 30,
                      right: 0,
                      background: '#fff',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      boxShadow: 'var(--shadow-md)',
                      padding: 4,
                      display: 'flex',
                      flexDirection: 'column',
                      minWidth: 140,
                      zIndex: 60,
                    }}
                  >
                    {ROLES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        style={menuItem(m.role === r)}
                        onClick={() => {
                          setOpenFor(null);
                          setErr(null);
                          start(async () => {
                            const res = await setRole(m.id, r);
                            if (!res.ok) setErr(res.error);
                          });
                        }}
                      >
                        <span>{r}</span>
                        <span
                          style={{
                            visibility: m.role === r ? 'visible' : 'hidden',
                            color: 'var(--blue-600)',
                          }}
                        >
                          ✓
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
              {!m.self && (
                <button
                  type="button"
                  onClick={() => {
                    setErr(null);
                    start(async () => {
                      const res = await remove(m.id);
                      if (!res.ok) setErr(res.error);
                    });
                  }}
                  style={{
                    fontSize: 12,
                    color: 'var(--slate-400)',
                    cursor: 'pointer',
                    background: 'none',
                    border: 'none',
                  }}
                >
                  Remove
                </button>
              )}
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--slate-600)' }}>{m.role}</span>
          )}
        </div>
      ))}

      {canEdit && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            borderTop: '1px solid var(--slate-100)',
            paddingTop: 12,
          }}
        >
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            style={{
              flex: 1,
              border: '1px solid var(--input)',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <button
            type="button"
            disabled={!email.includes('@') || pending}
            onClick={() => {
              setErr(null);
              setMsg(null);
              start(async () => {
                const res = await invite(workspaceId, email, 'reviewer');
                if (res.ok) {
                  setMsg(`${email} joins as reviewer once they accept.`);
                  setEmail('');
                } else setErr(res.error);
              });
            }}
            style={{
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 8,
              padding: '8px 16px',
              border: 'none',
              background: email.includes('@') ? 'var(--blue-600)' : 'var(--slate-200)',
              color: email.includes('@') ? '#fff' : 'var(--slate-500)',
              cursor: email.includes('@') ? 'pointer' : 'not-allowed',
            }}
          >
            Invite
          </button>
        </div>
      )}
      {msg && <span style={{ fontSize: 11, color: 'var(--green-900)' }}>{msg}</span>}
      {err && <span style={{ fontSize: 11, color: 'var(--red-600)' }}>{err}</span>}
    </div>
  );
}
