import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview } from '@/lib/core/requests';
import { dispatchDue, deliverOne, MAX_ATTEMPTS } from '@/lib/core/webhooks';
import { verifyWebhookSignature, generateWebhookSecret } from '@/lib/core/events';
import { webhookEndpoints, webhookDeliveries } from '@/lib/db/schema';
import { randomBytes } from 'crypto';

let fx: Fixtures;
let secret: string;
let endpointId: string;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures();
  secret = generateWebhookSecret(randomBytes(24));
  const [ep] = await db
    .insert(webhookEndpoints)
    .values({
      projectId: fx.projectId,
      url: 'https://pipeline.example/webhook',
      secret,
      eventTypes: [],
    })
    .returning();
  endpointId = ep.id;
});

function mockFetch(status: number) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe('webhook delivery', () => {
  it('signs per Standard Webhooks and marks delivered+acked on 2xx', async () => {
    await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'r/hook',
      title: 'T',
      contentMd: 'Hello world',
    });
    const { impl, calls } = mockFetch(200);
    const sent = await dispatchDue(db, impl);
    expect(sent).toBeGreaterThanOrEqual(2); // request.created + version.submitted

    const call = calls[0];
    const ts = Number(call.headers['webhook-timestamp']);
    expect(
      verifyWebhookSignature(secret, call.headers['webhook-id'], ts, call.body, call.headers['webhook-signature'])
    ).toBe(true);
    const envelope = JSON.parse(call.body);
    expect(envelope.data.request_id).toBe('r/hook');
    expect(envelope.data.hash).toMatch(/^[0-9a-f]{64}$/);

    const rows = await db.select().from(webhookDeliveries);
    expect(rows.every((r) => r.status === 'delivered' && r.ackedAt !== null)).toBe(true);
  });

  it('retries with the ladder then goes dead (DLQ) on persistent 5xx', async () => {
    await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'r/dead',
      title: 'T',
      contentMd: 'Hello world',
    });
    const { impl } = mockFetch(500);
    const [delivery] = await db.select().from(webhookDeliveries).limit(1);

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Force the backoff window to have elapsed.
      await db
        .update(webhookDeliveries)
        .set({ lastAttemptAt: new Date(Date.now() - 999_000) })
        .where(eq(webhookDeliveries.id, delivery.id));
      await deliverOne(db, delivery.id, impl);
    }

    const [after] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, delivery.id));
    expect(after.status).toBe('dead');
    expect(after.attempts).toBe(MAX_ATTEMPTS);

    // Dead deliveries are never retried.
    const again = await deliverOne(db, delivery.id, impl);
    expect(again).toBe('skipped');
  });

  it('event-type subscription filters deliveries', async () => {
    await db
      .update(webhookEndpoints)
      .set({ eventTypes: ['decision.accepted'] })
      .where(eq(webhookEndpoints.id, endpointId));
    await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'r/filtered',
      title: 'T',
      contentMd: 'Hello world',
    });
    const rows = await db.select().from(webhookDeliveries);
    expect(rows.length).toBe(0); // request.created/version.submitted not subscribed
  });
});
