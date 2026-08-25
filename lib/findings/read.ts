import { and, eq } from 'drizzle-orm';
import { judgeRuns, machineFindings, reviewRequests } from '@/lib/db/schema';
import { DbOrTx } from '@/lib/core/eventlog';

export type FindingsAudience = 'reviewer' | 'admin';

const REVIEWER_FINDING_FIELDS = [
  'id',
  'criterionKey',
  'severity',
  'quote',
  'startPos',
  'endPos',
  'structuralContainer',
  'structuralBlockId',
  'structuralOrdinal',
  'evidence',
  'note',
  'triage',
  'createdAt',
] as const;

export type ReviewerFinding = Pick<
  typeof machineFindings.$inferSelect,
  (typeof REVIEWER_FINDING_FIELDS)[number]
>;

export interface FindingsRead {
  findings: Array<typeof machineFindings.$inferSelect> | ReviewerFinding[];
  run: typeof judgeRuns.$inferSelect | null;
  withheld: boolean;
}

/**
 * Two read paths, one store. Reviewer-scoped reads drop withheld findings and
 * all run metadata on a blind request. Admin-scoped reads return everything.
 * New columns stay invisible to reviewers until they are added to the allow-list.
 */
export async function readFindings(
  db: DbOrTx,
  input: { requestId: string; versionId: string; audience: FindingsAudience }
): Promise<FindingsRead> {
  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, input.requestId),
  });
  const run = await db.query.judgeRuns.findFirst({
    where: eq(judgeRuns.versionId, input.versionId),
  });
  const rows = await db
    .select()
    .from(machineFindings)
    .where(
      and(
        eq(machineFindings.requestId, input.requestId),
        eq(machineFindings.versionId, input.versionId)
      )
    );

  const blind = Boolean(request?.judgeBlind);
  if (blind && input.audience === 'reviewer') {
    return { findings: [], run: null, withheld: true };
  }

  if (input.audience === 'reviewer') {
    const projected: ReviewerFinding[] = rows
      .filter((r) => r.triage !== 'suppressed' && !r.purgedAt)
      .map((r) => {
        const out = {} as ReviewerFinding;
        for (const k of REVIEWER_FINDING_FIELDS) {
          (out as Record<string, unknown>)[k] = r[k];
        }
        return out;
      });
    return { findings: projected, run: run ?? null, withheld: false };
  }

  return { findings: rows, run: run ?? null, withheld: false };
}

export async function untriagedFindings(db: DbOrTx, requestId: string, versionId: string) {
  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, requestId),
  });
  if (request?.judgeBlind) return [];
  return db
    .select()
    .from(machineFindings)
    .where(
      and(
        eq(machineFindings.requestId, requestId),
        eq(machineFindings.versionId, versionId),
        eq(machineFindings.triage, 'untriaged')
      )
    );
}
