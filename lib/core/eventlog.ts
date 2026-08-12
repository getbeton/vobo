import { and, asc, desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/lib/db/drizzle';
import { events, webhookEndpoints, webhookDeliveries, reviewRequests } from '@/lib/db/schema';
import { GENESIS_HASH, computeEventHash, verifyChain, ChainRow } from './events';
import { getStorage } from '@/lib/storage';
import { captureDomainEvent } from '@/lib/analytics/posthog';

export type Db = typeof defaultDb;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/**
 * Append one event to a request's chain. MUST be called inside a transaction
 * that has locked the request row (every mutating service does
 * `SELECT ... FOR UPDATE` on review_requests first) — that serializes seq
 * assignment per request; the (request_id, seq) unique index is the backstop.
 */
export async function appendEvent(
  tx: DbOrTx,
  requestId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<{ id: number; seq: number; hash: string }> {
  const [last] = await tx
    .select({ seq: events.seq, hash: events.hash })
    .from(events)
    .where(eq(events.requestId, requestId))
    .orderBy(desc(events.seq))
    .limit(1);

  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const hash = computeEventHash({ requestId, seq, type, payload, prevHash });

  const [row] = await tx
    .insert(events)
    .values({ requestId, seq, type, payload, prevHash, hash })
    .returning({ id: events.id });

  // Fan out to subscribed endpoints as pending deliveries (the worker sends).
  const request = await tx.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, requestId),
    columns: { projectId: true },
  });
  if (request) {
    const endpoints = await tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.projectId, request.projectId), eq(webhookEndpoints.active, true))
      );
    for (const ep of endpoints) {
      const subscribed =
        !Array.isArray(ep.eventTypes) ||
        (ep.eventTypes as string[]).length === 0 ||
        (ep.eventTypes as string[]).includes(type);
      if (subscribed) {
        await tx
          .insert(webhookDeliveries)
          .values({ eventId: row.id, endpointId: ep.id })
          .onConflictDoNothing();
      }
    }
  }

  // Product analytics ride the same taxonomy (no-op unless POSTHOG_KEY is set).
  void captureDomainEvent({
    type,
    requestId,
    distinctId: typeof payload.userId === 'string' ? payload.userId : null,
    payload,
  });

  // Best-effort JSONL mirror to BYO storage (offline archive). Non-fatal.
  try {
    await getStorage().appendJsonl(`events/${requestId}.jsonl`, {
      id: row.id,
      requestId,
      seq,
      type,
      payload,
      prevHash,
      hash,
    });
  } catch (err) {
    console.warn('event mirror write failed (non-fatal):', err);
  }

  return { id: row.id, seq, hash };
}

/** Load and verify one request's full chain. */
export async function getVerifiedChain(dbh: DbOrTx, requestId: string) {
  const rows = await dbh
    .select()
    .from(events)
    .where(eq(events.requestId, requestId))
    .orderBy(asc(events.seq));
  const verification = verifyChain(rows as unknown as ChainRow[]);
  return { rows, verification };
}
