import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints, events, reviewRequests } from '@/lib/db/schema';
import { webhookHeaders } from './events';
import { Db } from './eventlog';

/**
 * Webhook delivery with the Standard Webhooks retry ladder [10s, 60s, 180s]
 * then DLQ ('dead'). State lives entirely in Postgres, so deploy restarts
 * never lose in-flight deliveries (the reason the worker exists at all).
 * MVP deviation from the pg-boss plan: a plain poll loop — same guarantees
 * at this scale, one less moving part; revisit when volume demands.
 */

const BACKOFF_SECONDS = [10, 60, 180];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;
const TIMEOUT_MS = 15_000;

export function backoffCutoff(attempts: number, now: Date): Date {
  const wait = BACKOFF_SECONDS[Math.min(attempts, MAX_ATTEMPTS - 1)];
  return new Date(now.getTime() - wait * 1000);
}

/** Deliveries that are due right now (pending, or failed past their backoff). */
export async function dueDeliveries(db: Db, limit = 50) {
  const now = new Date();
  return db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(
      and(
        inArray(webhookDeliveries.status, ['pending', 'failed']),
        or(
          isNull(webhookDeliveries.lastAttemptAt),
          lt(webhookDeliveries.lastAttemptAt, backoffCutoff(0, now)) // recheck below per-row
        )
      )
    )
    .limit(limit);
}

export async function deliverOne(
  db: Db,
  deliveryId: string,
  fetchImpl: typeof fetch = fetch
): Promise<'delivered' | 'failed' | 'dead' | 'skipped'> {
  const row = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  if (!row.length) return 'skipped';
  const { delivery, endpoint } = row[0];
  if (!['pending', 'failed'].includes(delivery.status)) return 'skipped';

  // Respect the ladder precisely per-row.
  if (delivery.lastAttemptAt) {
    const due = new Date(
      delivery.lastAttemptAt.getTime() +
        BACKOFF_SECONDS[Math.min(delivery.attempts - 1, MAX_ATTEMPTS - 1)] * 1000
    );
    if (due.getTime() > Date.now()) return 'skipped';
  }

  const [event] = await db.select().from(events).where(eq(events.id, delivery.eventId));
  if (!event) return 'skipped';
  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, event.requestId),
  });

  const envelope = JSON.stringify({
    id: `evt_${event.id}`,
    type: event.type,
    timestamp: event.createdAt.toISOString(),
    data: {
      request_id: request?.customerRequestId,
      seq: event.seq,
      hash: event.hash,
      prev_hash: event.prevHash,
      ...(event.payload as Record<string, unknown>),
    },
  });

  const attempts = delivery.attempts + 1;
  let ok = false;
  let code: number | null = null;
  try {
    const res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: webhookHeaders(endpoint.secret, `evt_${event.id}`, new Date(), envelope),
      body: envelope,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    code = res.status;
    ok = res.ok;
  } catch {
    ok = false;
  }

  if (ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'delivered',
        attempts,
        lastAttemptAt: new Date(),
        ackedAt: new Date(),
        responseCode: code,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return 'delivered';
  }

  const dead = attempts >= MAX_ATTEMPTS;
  await db
    .update(webhookDeliveries)
    .set({
      status: dead ? 'dead' : 'failed',
      attempts,
      lastAttemptAt: new Date(),
      responseCode: code,
    })
    .where(eq(webhookDeliveries.id, delivery.id));
  return dead ? 'dead' : 'failed';
}

export async function dispatchDue(db: Db, fetchImpl: typeof fetch = fetch): Promise<number> {
  const due = await dueDeliveries(db);
  let sent = 0;
  for (const { delivery } of due) {
    const result = await deliverOne(db, delivery.id, fetchImpl);
    if (result === 'delivered') sent++;
  }
  return sent;
}
