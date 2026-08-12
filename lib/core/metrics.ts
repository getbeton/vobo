/**
 * Entity-page metrics — the five-stat strip shared by the workspace, project
 * and queue pages (design/vobo-review-station.dc.html → metricsFor/statRow).
 *
 * Deliberate deviation from the prototype: the prototype hardcodes $1.90 per
 * round to demo "per accepted unit". A real deployment cannot know that, so
 * cost renders "—" unless VOBO_COST_PER_ROUND is configured. Every other
 * number is computed from real rows.
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
