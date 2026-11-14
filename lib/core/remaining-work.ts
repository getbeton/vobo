import { and, eq, isNull } from 'drizzle-orm';
import { reviewRequests } from '@/lib/db/schema';
import type { DbOrTx } from './eventlog';
import { remainingWork, type RemainingWork } from './metrics';

/** Live rows on one queue. Caller already scoped by environment via queue id. */
export async function remainingWorkForQueue(db: DbOrTx, queueId: string): Promise<RemainingWork> {
  const rows = await db
    .select({ status: reviewRequests.status })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.queueId, queueId), isNull(reviewRequests.archivedAt)));
  return remainingWork(rows);
}
