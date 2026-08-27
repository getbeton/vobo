import { and, eq, sql } from 'drizzle-orm';
import { machineFindings, reviewRequests } from '@/lib/db/schema';
import { Db } from '@/lib/core/eventlog';

export const AGREEMENT_MIN_N = 20;
export const BLIND_SPAN_OVERLAP = 0.5;

export interface AgreementRow {
  criterionKey: string;
  emitted: number;
  confirmed: number;
  dismissed: number;
  confirmRate: number | null;
}

/**
 * Sighted agreement from triage. Blind findings are never triaged, so they
 * cannot enter this query (ARD §26.5).
 */
export async function sightedAgreement(db: Db, queueId: string): Promise<AgreementRow[]> {
  const rows = await db
    .select({
      criterionKey: machineFindings.criterionKey,
      emitted: sql<number>`count(*) filter (where ${machineFindings.triage} <> 'suppressed')::int`,
      confirmed: sql<number>`count(*) filter (where ${machineFindings.triage} = 'confirmed')::int`,
      dismissed: sql<number>`count(*) filter (where ${machineFindings.triage} = 'dismissed')::int`,
    })
    .from(machineFindings)
    .innerJoin(reviewRequests, eq(reviewRequests.id, machineFindings.requestId))
    .where(and(eq(reviewRequests.queueId, queueId), eq(reviewRequests.judgeBlind, false)))
    .groupBy(machineFindings.criterionKey);

  return rows.map((r) => {
    const triaged = r.confirmed + r.dismissed;
    return {
      criterionKey: r.criterionKey,
      emitted: r.emitted,
      confirmed: r.confirmed,
      dismissed: r.dismissed,
      confirmRate: triaged >= AGREEMENT_MIN_N ? r.confirmed / triaged : null,
    };
  });
}

/**
 * Blind agreement is a match against independently authored corrections, not
 * triage. This v1 returns counts of withheld findings only; the span-overlap
 * matcher is the named constant BLIND_SPAN_OVERLAP and is tested separately.
 */
export async function blindFindingCounts(db: Db, queueId: string) {
  const rows = await db
    .select({
      criterionKey: machineFindings.criterionKey,
      n: sql<number>`count(*)::int`,
    })
    .from(machineFindings)
    .innerJoin(reviewRequests, eq(reviewRequests.id, machineFindings.requestId))
    .where(and(eq(reviewRequests.queueId, queueId), eq(reviewRequests.judgeBlind, true)))
    .groupBy(machineFindings.criterionKey);
  return rows;
}

export function spanOverlap(
  a: { startPos: number; endPos: number },
  b: { startPos: number; endPos: number }
): number {
  const start = Math.max(a.startPos, b.startPos);
  const end = Math.min(a.endPos, b.endPos);
  const overlap = Math.max(0, end - start);
  const denom = Math.max(a.endPos - a.startPos, b.endPos - b.startPos, 1);
  return overlap / denom;
}