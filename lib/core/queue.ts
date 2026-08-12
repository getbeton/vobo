import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { reviewRequests, leases, queues } from '@/lib/db/schema';
import { appendEvent, Db, DbOrTx } from './eventlog';
import { ApiProblem, getPolicyForRequest } from './requests';

/**
 * Queue ranking + atomic leases. Ranking rules are Policy-owned (reviewers
 * never configure sorting): sticky regenerations pin to the top for their
 * reviewer, then the policy's rule order (sla → priority → fifo in MVP).
 */

export interface QueueRow {
  request: typeof reviewRequests.$inferSelect;
  lease: { userId: string; expiresAt: Date } | null;
  sticky: boolean;
  rankRationale: string;
}

export async function rankedQueue(db: DbOrTx, queueId: string, userId: string): Promise<QueueRow[]> {
  const rows = await db
    .select({ request: reviewRequests, lease: leases })
    .from(reviewRequests)
    .leftJoin(leases, eq(leases.requestId, reviewRequests.id))
    .where(
      and(eq(reviewRequests.queueId, queueId), inArray(reviewRequests.status, ['open', 'claimed']))
    )
    .orderBy(
      sql`case when ${reviewRequests.stickyReviewerId} = ${userId} then 0 else 1 end`,
      sql`${reviewRequests.slaDueAt} asc nulls last`,
      asc(reviewRequests.priority),
      asc(reviewRequests.createdAt)
    );

  const now = Date.now();
  return rows.map(({ request, lease }) => {
    const liveLease = lease && lease.expiresAt.getTime() > now ? lease : null;
    const sticky = request.stickyReviewerId === userId && request.round > 1;
    const parts = [
      sticky ? 'sticky: returning to you' : null,
      request.slaDueAt ? `sla ${request.slaDueAt.toISOString()}` : 'no sla',
      `priority P${request.priority}`,
      'fifo',
    ].filter(Boolean);
    return {
      request,
      lease: liveLease ? { userId: liveLease.userId, expiresAt: liveLease.expiresAt } : null,
      sticky,
      rankRationale: parts.join(' · '),
    };
  });
}

/**
 * Atomic claim: locks the request row; exactly one concurrent claimer wins.
 * Losing claimers get a 409 race error (the queue UI auto-advances focus).
 */
export async function claim(db: Db, requestId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, requestId))
      .for('update');
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (request.status !== 'open')
      throw new ApiProblem(409, 'not_claimable', `Request is ${request.status}`);

    const [existing] = await tx.select().from(leases).where(eq(leases.requestId, requestId));
    if (existing) {
      if (existing.expiresAt.getTime() > Date.now()) {
        throw new ApiProblem(409, 'claim_race', 'Claimed by another reviewer just now');
      }
      await tx.delete(leases).where(eq(leases.id, existing.id));
    }

    const policy = await getPolicyForRequest(tx, request.policyVersionId);
    const expiresAt = new Date(Date.now() + policy.leaseMinutes * 60_000);
    await tx.insert(leases).values({ requestId, userId, expiresAt });
    await tx
      .update(reviewRequests)
      .set({ status: 'claimed', updatedAt: new Date() })
      .where(eq(reviewRequests.id, requestId));
    await appendEvent(tx, requestId, 'request.claimed', { user_id: userId });
    return { expiresAt };
  });
}

export async function release(db: Db, requestId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, requestId))
      .for('update');
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    const [lease] = await tx.select().from(leases).where(eq(leases.requestId, requestId));
    if (!lease || lease.userId !== userId)
      throw new ApiProblem(409, 'not_lease_holder', 'You do not hold this lease');
    await tx.delete(leases).where(eq(leases.id, lease.id));
    if (request.status === 'claimed') {
      await tx
        .update(reviewRequests)
        .set({ status: 'open', updatedAt: new Date() })
        .where(eq(reviewRequests.id, requestId));
    }
    await appendEvent(tx, requestId, 'request.released', { user_id: userId });
  });
}

/** Worker sweep: expired leases return their requests to the queue. */
export async function expireLeases(db: Db): Promise<number> {
  const expired = await db.select().from(leases).where(lt(leases.expiresAt, new Date()));
  let count = 0;
  for (const lease of expired) {
    await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(reviewRequests)
        .where(eq(reviewRequests.id, lease.requestId))
        .for('update');
      const [still] = await tx.select().from(leases).where(eq(leases.id, lease.id));
      if (!still || still.expiresAt.getTime() > Date.now()) return;
      await tx.delete(leases).where(eq(leases.id, lease.id));
      if (request && request.status === 'claimed') {
        await tx
          .update(reviewRequests)
          .set({ status: 'open', updatedAt: new Date() })
          .where(eq(reviewRequests.id, request.id));
        await appendEvent(tx, request.id, 'lease.expired', { user_id: lease.userId });
        count++;
      }
    });
  }
  return count;
}

/** Worker sweep: SLA timeouts apply the policy's fail mode with a flagged event. */
export async function applySlaTimeouts(db: Db): Promise<number> {
  const due = await db
    .select()
    .from(reviewRequests)
    .where(
      and(
        inArray(reviewRequests.status, ['open', 'claimed']),
        lt(reviewRequests.slaDueAt, new Date())
      )
    );
  let count = 0;
  for (const req of due) {
    await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(reviewRequests)
        .where(eq(reviewRequests.id, req.id))
        .for('update');
      if (!request || !['open', 'claimed'].includes(request.status)) return;
      if (!request.slaDueAt || request.slaDueAt.getTime() > Date.now()) return;
      const policy = await getPolicyForRequest(tx, request.policyVersionId);
      const failOpen = policy.slaFailMode === 'fail_open';
      await tx
        .update(reviewRequests)
        .set({ status: failOpen ? 'accepted' : 'escalated', updatedAt: new Date() })
        .where(eq(reviewRequests.id, request.id));
      await tx.delete(leases).where(eq(leases.requestId, request.id));
      await appendEvent(tx, request.id, 'sla.timeout', {
        mode: policy.slaFailMode,
        flagged_unreviewed: true,
      });
      count++;
    });
  }
  return count;
}
