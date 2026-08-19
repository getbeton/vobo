'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Bell,
  ListChecks,
  History,
  Activity,
  Settings,
} from 'lucide-react';
import {
  readSelection,
  projectTarget,
  queueTarget,
  environmentTarget,
  optionsWithSelection,
  selectedLabel,
  selectProject,
  type ProjectOption,
} from '@/lib/shell/crumbs';

/**
 * App chrome, ported verbatim from design/vobo-review-station.dc.html:
 * 56px top bar with the Vobo / Workspace / Project / Queue / Environment
 * breadcrumb (switcher when multiple, link when single), operator alert
 * bell, `?` keyboard sheet; left icon rail (queue · timeline · convergence
 * placeholder · settings).
 */

export interface CrumbOption {
  label: string;
  href?: string;
  value: string;
  selected?: boolean;
}

export interface ShellProject extends ProjectOption {
  href: string;
}

export interface ShellData {
  workspace: { name: string; href: string };
  /** Every project in the workspace, deterministically ordered. */
  projects: ShellProject[];
  alerts: Array<{ id: string; text: string; kind: string; at: string }>;
}

const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 13,
  fontWeight: 500,
  background: '#fff',
  cursor: 'pointer',
  color: 'var(--slate-600)',
};

function CrumbMenu({
  label,
  options,
  title,
  onPick,
}: {
  label: string;
  options: CrumbOption[];
  title: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  if (options.length <= 1) {
    const only = options[0];
    return only?.href ? (
      <Link
        href={only.href}
        title={`${title} — click opens its page`}
        style={{ color: 'var(--slate-500)', fontSize: 13, textDecoration: 'none' }}
      >
        {label}
      </Link>
    ) : (
      <span style={{ color: 'var(--slate-500)', fontSize: 13 }}>{label}</span>
    );
  }
  return (
    <span ref={box} style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} title={title} style={chip}>
        {label}
        <span style={{ fontSize: 9, color: 'var(--slate-400)' }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 38,
            left: 0,
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-md)',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 220,
            zIndex: 60,
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(o.value);
              }}
              style={{
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
                color: 'var(--slate-800)',
              }}
            >
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {o.label}
              </span>
              <span style={{ visibility: o.selected ? 'visible' : 'hidden', color: 'var(--blue-600)' }}>
                ✓
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const KEYMAP: Array<[string, string]> = [
  ['J / K', 'Move focus through rows and findings'],
  ['Enter / N', 'Claim next / open focused item'],
  ['R', 'Release your lease'],
  ['A', 'Anchor a correction on the selection'],
  ['C / D', 'Confirm / dismiss (with reason)'],
  ['1–5', 'Score the focused criterion'],
  ['P / O / X', 'Persists / re-pin / retire (compare rail)'],
  ['⌘Enter', 'Open the pre-submit sheet / ship'],
  ['Esc', 'Close composer or sheet'],
  ['?', 'This sheet'],
];

export function AppShell({ data, children }: { data: ShellData; children: ReactNode }) {
  const [bellOpen, setBellOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !(e.target as HTMLElement)?.closest('input,textarea')) {
        setSheetOpen((s) => !s);
      }
      if (e.key === 'Escape') {
        setSheetOpen(false);
        setBellOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const railItems = [
    { icon: ListChecks, title: 'Reviewer queue', href: '/queue' },
    { icon: History, title: 'Request timeline', href: '/requests' },
    { icon: Activity, title: 'Convergence dashboard — coming soon', href: null as string | null },
    { icon: Settings, title: 'Workspace, project & queue pages', href: '/admin' },
  ];

  const searchParams = useSearchParams();

  // Selection comes from the URL, never from the first row. That mismatch is
  // how the crumb could name a queue the body was not showing.
  const selection = readSelection({
    project: searchParams.get('project'),
    queue: searchParams.get('queue'),
    env: searchParams.get('env'),
  });

  const selectedProject = selectProject(data.projects, selection);

  const projectOptions = optionsWithSelection(
    data.projects.map((p) => ({
      label: p.name,
      slug: p.slug,
      value: projectTarget(selection, p),
    })),
    selectedProject?.slug ?? null
  );

  const queueOptions = optionsWithSelection(
    (selectedProject?.queueSlugs ?? []).map((slug) => ({
      label: slug,
      slug,
      value: queueTarget({ ...selection, projectSlug: selectedProject?.slug ?? null }, slug),
    })),
    selection.queueSlug
  );

  const environmentOptions = (['production', 'test'] as const).map((env) => ({
    label: env,
    value: environmentTarget(
      { ...selection, projectSlug: selectedProject?.slug ?? null },
      env
    ),
    selected: selection.environment === env,
  }));

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        fontSize: 14,
        overflow: 'hidden',
        background: 'var(--slate-50)',
        color: 'var(--slate-950)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 56,
          padding: '0 20px',
          background: '#fff',
          borderBottom: '1px solid var(--border)',
          flex: 'none',
          position: 'relative',
          zIndex: 30,
        }}
      >
        <Link
          href="/queue"
          style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-.01em', color: 'inherit', textDecoration: 'none' }}
        >
          Vobo
        </Link>
        <span style={{ color: 'var(--slate-300)' }}>/</span>
        <CrumbMenu
          label={data.workspace.name}
          title="Workspace"
          options={[
            { label: data.workspace.name, value: 'ws', href: data.workspace.href, selected: true },
          ]}
          onPick={() => {}}
        />
        <span style={{ color: 'var(--slate-300)' }}>/</span>
        <CrumbMenu
          label={selectedLabel(projectOptions, 'project')}
          title="Project"
          options={
            data.projects.length === 1
              ? [
                  {
                    label: data.projects[0].name,
                    value: 'p',
                    href: data.projects[0].href,
                    selected: true,
                  },
                ]
              : projectOptions
          }
          onPick={(v) => router.push(v)}
        />
        <span style={{ color: 'var(--slate-300)' }}>/</span>
        <CrumbMenu
          label={selectedLabel(queueOptions, 'queue')}
          title="Queue"
          options={
            queueOptions.length === 1 && selectedProject
              ? [
                  {
                    label: queueOptions[0].label,
                    value: 'q',
                    href: queueOptions[0].value,
                    selected: true,
                  },
                ]
              : queueOptions
          }
          onPick={(v) => router.push(v)}
        />
        <span style={{ color: 'var(--slate-300)' }}>/</span>
        <CrumbMenu
          label={selection.environment}
          title="Environment — a property of the queue"
          options={environmentOptions}
          onPick={(v) => router.push(v)}
        />

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            title="Keyboard shortcuts"
            onClick={() => setSheetOpen(true)}
            style={{ ...chip, width: 32, height: 32, padding: 0, justifyContent: 'center' }}
          >
            ?
          </button>
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              title="Operator alert feed"
              onClick={() => setBellOpen((o) => !o)}
              style={{ ...chip, width: 32, height: 32, padding: 0, justifyContent: 'center' }}
            >
              <Bell size={15} />
              {data.alerts.length > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -3,
                    right: -3,
                    background: 'var(--red-500)',
                    color: '#fff',
                    borderRadius: 999,
                    fontSize: 10,
                    minWidth: 16,
                    height: 16,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 3px',
                  }}
                >
                  {data.alerts.length}
                </span>
              )}
            </button>
            {bellOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 40,
                  right: 0,
                  width: 360,
                  background: '#fff',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-lg)',
                  padding: 10,
                  zIndex: 70,
                  maxHeight: 420,
                  overflow: 'auto',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13, padding: '4px 6px 8px' }}>
                  Operator alert feed
                </div>
                {data.alerts.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--slate-500)', padding: '4px 6px 8px' }}>
                    No alerts yet — verdicts, SLA nudges, and ignored-correction alerts land here.
                  </div>
                ) : (
                  data.alerts.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        padding: '8px 6px',
                        borderTop: '1px solid var(--slate-100)',
                        fontSize: 13,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span>{a.text}</span>
                      <span style={{ fontSize: 11, color: 'var(--slate-400)' }}>
                        {a.kind} · {a.at}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 52,
            flex: 'none',
            background: '#fff',
            borderRight: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 10,
            gap: 6,
          }}
        >
          {railItems.map(({ icon: Icon, title, href }) => {
            const active = href && pathname.startsWith(href);
            const inner = (
              <span
                title={title}
                style={{
                  width: 36,
                  height: 36,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 8,
                  color: active ? 'var(--blue-700)' : 'var(--slate-500)',
                  background: active ? 'var(--blue-50)' : 'transparent',
                  cursor: href ? 'pointer' : 'not-allowed',
                  opacity: href ? 1 : 0.45,
                }}
              >
                <Icon size={17} />
              </span>
            );
            return href ? (
              <Link key={title} href={href} style={{ display: 'inline-flex' }}>
                {inner}
              </Link>
            ) : (
              <span key={title}>{inner}</span>
            );
          })}
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>{children}</div>
      </div>

      {sheetOpen && (
        <div
          onClick={() => setSheetOpen(false)}
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
              width: 420,
              maxWidth: '92vw',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 10 }}>Keyboard</div>
            {KEYMAP.map(([k, d]) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  fontSize: 13,
                  padding: '5px 0',
                  borderTop: '1px solid var(--slate-100)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    background: 'var(--slate-100)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {k}
                </span>
                <span style={{ color: 'var(--slate-600)', textAlign: 'right' }}>{d}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
