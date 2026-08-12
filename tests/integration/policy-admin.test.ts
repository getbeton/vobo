import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { queues, workspaces, policyVersions, reviewRequests } from '@/lib/db/schema';
import { publishQueuePolicy, resolveQueuePolicy } from '@/lib/core/policy-store';
import { createReview } from '@/lib/core/requests';

/**
 * Policy administration: workspace defaults + per-queue overrides resolve into
 * immutable policy versions, and an in-flight request keeps the version it was
 * stamped with.
 */

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({ roundBudget: 3, slaMinutes: null });
});

async function setOverrides(queueId: string, overrides: Record<string, unknown>) {
  await db.update(queues).set({ policyOverrides: overrides }).where(eq(queues.id, queueId));
}

async function setDefaults(workspaceId: number, defaults: Record<string, unknown>) {
  await db.update(workspaces).set({ policyDefaults: defaults }).where(eq(workspaces.id, workspaceId));
}

describe('policy resolution', () => {
  it('inherits workspace defaults when the queue overrides nothing', async () => {
    await setDefaults(fx.workspaceId, { roundBudget: 4 });
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(4);
    expect(resolved.overrideKeys).toEqual([]);
  });

  it('lets a queue override a single key without touching the rest', async () => {
    await setDefaults(fx.workspaceId, { roundBudget: 4, blindN: 2 });
    await setOverrides(fx.queueId, { roundBudget: 2 });
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(2);
    expect(resolved.config.blindN).toBe(2); // still inherited
    expect(resolved.overrideKeys).toEqual(['roundBudget']);
  });
});

describe('publishQueuePolicy', () => {
  it('publishes a new version when the resolved config changes', async () => {
    await setOverrides(fx.queueId, { roundBudget: 2 });
    const res = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(res.changed).toBe(true);
    expect(res.version).toBe(2);

    const queue = await db.query.queues.findFirst({ where: eq(queues.id, fx.queueId) });
    expect(queue?.activePolicyVersionId).toBe(res.policyVersionId);

    const pv = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, res.policyVersionId),
    });
    expect((pv!.config as { roundBudget: number }).roundBudget).toBe(2);
  });

  it('is a no-op when nothing actually changed — version numbers are user-visible', async () => {
    const first = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(first.changed).toBe(false);
    const again = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(again.changed).toBe(false);
    expect(again.version).toBe(1);
  });

  it('never mutates a published version — it appends a new one', async () => {
    const original = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, fx.policyVersionId),
    });
    await setOverrides(fx.queueId, { roundBudget: 4 });
    await publishQueuePolicy(db, fx.queueId, fx.userId);

    const after = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, fx.policyVersionId),
    });
    expect(after!.config).toEqual(original!.config);

    const all = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.queueId, fx.queueId));
    expect(all).toHaveLength(2);
  });

  it('leaves in-flight requests on the version they were stamped with', async () => {
    const created = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'pico/acme/email-1',
      title: 'Acme email',
      contentMd: 'Hello there.',
    });
    const before = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, created.request.id),
    });

    await setOverrides(fx.queueId, { roundBudget: 4 });
    const published = await publishQueuePolicy(db, fx.queueId, fx.userId);

    const after = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, created.request.id),
    });
    expect(after!.policyVersionId).toBe(before!.policyVersionId);
    expect(after!.policyVersionId).not.toBe(published.policyVersionId);
  });

  it('propagates a workspace-default change into an inheriting queue', async () => {
    await setDefaults(fx.workspaceId, { roundBudget: 4 });
    const res = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(res.changed).toBe(true);
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(4);
    expect(resolved.version).toBe(2);
  });

  it('does not propagate a workspace default into a queue that overrides that key', async () => {
    await setOverrides(fx.queueId, { roundBudget: 2 });
    await publishQueuePolicy(db, fx.queueId, fx.userId);
    await setDefaults(fx.workspaceId, { roundBudget: 4 });
    const res = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(res.changed).toBe(false);
    expect((await resolveQueuePolicy(db, fx.queueId)).config.roundBudget).toBe(2);
  });
});
