/**
 * Entity-page metrics — the five-stat strip shared by the workspace, project
 * and queue pages (design/vobo-review-station.dc.html → metricsFor/statRow).
 *
 * Deliberate deviation from the prototype: the prototype hardcodes $1.90 per
 * round to demo "per accepted unit". A real deployment cannot know that, so
 * cost renders "—" unless VOBO_COST_PER_ROUND is configured. Every other
 * number is computed from real rows.
 *
 * Remaining work (VOBO-295) is a separate pair. Do not reuse `computeMetrics.open`:
 * that helper drops rejected. Remaining includes rejected.
 */

export interface RequestMetricRow {
  status: string;
  round: number;
}

export interface EntityMetrics {
  accepted: number;
  decided: number;
  open: number;
  /** First-pass yield: accepted on round 1 / all accepted. */
  fpy: string;
  /** Mean rounds to accept. */
  rta: string;
  /** Cost per accepted unit, or "—" when no per-round cost is configured. */
  cost: string;
}

const DASH = '—';

const REMAINING_STATUSES = ['open', 'claimed', 'rejected', 'escalated', 'held_blind'] as const;
export type RemainingStatus = (typeof REMAINING_STATUSES)[number];

export interface RemainingWork {
  remaining: number;
  accepted: number;
  split: Record<RemainingStatus, number>;
}

/**
 * Remaining = live rows that are not accepted. Rejected is remaining.
 * Caller must pass only non-archived rows.
 */
export function remainingWork(rows: Array<{ status: string }>): RemainingWork {
  const split: Record<RemainingStatus, number> = {
    open: 0,
    claimed: 0,
    rejected: 0,
    escalated: 0,
    held_blind: 0,
  };
  let accepted = 0;
  for (const r of rows) {
    if (r.status === 'accepted') {
      accepted += 1;
      continue;
    }
    if ((REMAINING_STATUSES as readonly string[]).includes(r.status)) {
      split[r.status as RemainingStatus] += 1;
    }
  }
  const remaining = split.open + split.claimed + split.rejected + split.escalated + split.held_blind;
  return { remaining, accepted, split };
}

export function remainingWorkLabel(w: RemainingWork): string {
  return `${w.remaining} remaining · ${w.accepted} accepted`;
}

export function remainingWorkTitle(w: RemainingWork): string {
  return `open ${w.split.open} / claimed ${w.split.claimed} / rejected ${w.split.rejected} / escalated ${w.split.escalated} / held_blind ${w.split.held_blind}`;
}

export function computeMetrics(rows: RequestMetricRow[]): EntityMetrics {
  const accepted = rows.filter((r) => r.status === 'accepted');
  const decided = rows.filter(
    (r) => r.status === 'accepted' || r.status === 'escalated'
  ).length;
  const open = rows.filter(
    (r) => r.status === 'open' || r.status === 'claimed' || r.status === 'held_blind'
  ).length;
  const rounds = accepted.reduce((a, r) => a + r.round, 0);
  const perRound = Number(process.env.VOBO_COST_PER_ROUND ?? '') || 0;

  return {
    accepted: accepted.length,
    decided,
    open,
    fpy: accepted.length
      ? `${Math.round((accepted.filter((r) => r.round === 1).length / accepted.length) * 100)}%`
      : DASH,
    rta: accepted.length ? (rounds / accepted.length).toFixed(1) : DASH,
    cost:
      accepted.length && perRound
        ? `$${((rounds * perRound) / accepted.length).toFixed(2)}`
        : DASH,
  };
}

/** The strip in prototype order; `hot` marks the blue headline stat. */
export function statStrip(m: EntityMetrics): Array<{ v: string; l: string; hot?: boolean }> {
  return [
    { v: m.fpy, l: 'First-pass yield', hot: true },
    { v: m.rta, l: 'Rounds to accept' },
    { v: m.cost, l: 'Per accepted unit' },
    { v: String(m.open), l: 'Open now' },
    { v: String(m.decided), l: 'Decided' },
  ];
}
