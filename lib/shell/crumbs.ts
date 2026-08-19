/**
 * Breadcrumb selection and target URLs.
 *
 * VOBO-206: the top-bar crumbs were decoration. The workspace and project
 * crumbs were fed a hard-coded one-element array, so `CrumbMenu` always took
 * its `options.length <= 1` branch and rendered a plain link — the button was
 * unreachable code. Every queue option carried `selected: true`, so the tick
 * appeared on every row and the label came from the first row rather than the
 * URL. The environment options were the bare strings `/queue?env=production`
 * and `/queue?env=test`, so switching environment silently moved the reviewer
 * to a different queue.
 *
 * All of that is URL arithmetic. It lives here as pure functions so it can be
 * tested without a browser, and so the shell and the page cannot disagree
 * about which queue is open.
 */

export type Environment = 'production' | 'test';

export interface CrumbSelection {
  projectSlug: string | null;
  queueSlug: string | null;
  environment: Environment;
}

export interface ProjectOption {
  slug: string;
  name: string;
  /** Queue slugs of this project, in resolution order. */
  queueSlugs: string[];
}

/** Reads the selection out of the URL. The URL is the only source of truth. */
export function readSelection(params: {
  project?: string | null;
  queue?: string | null;
  env?: string | null;
}): CrumbSelection {
  return {
    projectSlug: params.project ?? null,
    queueSlug: params.queue ?? null,
    environment: params.env === 'test' ? 'test' : 'production',
  };
}

function href(sel: CrumbSelection): string {
  const q = new URLSearchParams();
  if (sel.projectSlug) q.set('project', sel.projectSlug);
  if (sel.queueSlug) q.set('queue', sel.queueSlug);
  q.set('env', sel.environment);
  return `/queue?${q.toString()}`;
}

/**
 * Switching project keeps the queue slug when that slug exists in the new
 * project, and otherwise falls to that project's first queue. Keeping a slug
 * that does not exist there would land the reader on a not-found state.
 */
export function projectTarget(
  current: CrumbSelection,
  target: ProjectOption
): string {
  const queueSlug =
    current.queueSlug && target.queueSlugs.includes(current.queueSlug)
      ? current.queueSlug
      : (target.queueSlugs[0] ?? null);
  return href({ ...current, projectSlug: target.slug, queueSlug });
}

/** Switching queue keeps the project and the environment. */
export function queueTarget(current: CrumbSelection, queueSlug: string): string {
  return href({ ...current, queueSlug });
}

/** Switching environment keeps the project and the queue. */
export function environmentTarget(
  current: CrumbSelection,
  environment: Environment
): string {
  return href({ ...current, environment });
}

export interface CrumbOptionData {
  label: string;
  value: string;
  selected: boolean;
}

/**
 * Exactly one option is ticked. `selectedSlug` comes from the URL; when it is
 * absent or unknown, the first option is the selection, matching the
 * resolver's default.
 */
export function optionsWithSelection(
  items: Array<{ label: string; slug: string; value: string }>,
  selectedSlug: string | null
): CrumbOptionData[] {
  const known = selectedSlug && items.some((i) => i.slug === selectedSlug);
  const effective = known ? selectedSlug : (items[0]?.slug ?? null);
  return items.map((i) => ({
    label: i.label,
    value: i.value,
    selected: i.slug === effective,
  }));
}

/** The label the crumb shows — always the ticked option. */
export function selectedLabel(
  options: CrumbOptionData[],
  fallback: string
): string {
  return options.find((o) => o.selected)?.label ?? fallback;
}
