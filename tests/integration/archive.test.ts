import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { events, leases, reviewRequests } from '@/lib/db/schema';
import { createReview, submitVersion } from '@/lib/core/requests';
import { archiveRequests, claim, rankedQueue, applySlaTimeouts } from '@/lib/core/queue';
import { ship } from '@/lib/core/verdict';
import { getVerifiedChain } from '@/lib/core/eventlog';
import { GET as getReview } from '@/app/api/v1/review/route';
import { GET as listReviews } from '@/app/api/v1/reviews/route';

/**
 * VOBO-224. 425 open requests landed in one batch and some accounts get killed
 * outright. Archive takes a request off the board without a verdict, and it has
 * to be as auditable as a verdict.
 */
describe('archiveRequests', () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;
  let ids: string[];

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    fixtures = await createFixtures();
    ids = [];
    for (let i = 0; i < 4; i++) {
      const { request } = await createReview(db, {
        projectId: fixtures.projectId,
        queueSlug: 'q',
        environment: 'production',
        customerRequestId: `arch/${i}`,
        title: `Request ${i}`,
        contentMd: `Body ${i}`,
      });
      ids.push(request.id);
    }
  });

  afterAll(async () => {
    await client.end();
  });

  it('stamps who archived it and when', async () => {
    const res = await archiveRequests(db, {
      requestIds: [ids[0], ids[1]],
      userId: fixtures.userId,
    });
    expect(res.archived).toHaveLength(2);
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].archivedAt).toBeInstanceOf(Date);
    expect(rows[0].archivedBy).toBe(fixtures.userId);
  });

  it('leaves the status alone — archive is not a verdict', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].status).toBe('open');
  });

  it('drops the request out of the ranked queue', async () => {
    const before = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(before).toHaveLength(4);
    await archiveRequests(db, { requestIds: [ids[0], ids[2]], userId: fixtures.userId });
    const after = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(after.map((r) => r.request.id).sort()).toEqual([ids[1], ids[3]].sort());
  });

  it('appends one request.archived event per request, with the actor', async () => {
    await archiveRequests(db, {
      requestIds: [ids[0], ids[1], ids[2]],
      userId: fixtures.userId,
      reason: 'account killed at the gate',
    });
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, ids[1]), eq(events.type, 'request.archived')));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.by).toBe(fixtures.userId);
    expect(payload.status_at_archive).toBe('open');
    expect(payload.batch_size).toBe(3);
    expect(payload.reason).toBe('account killed at the gate');
  });

  it('keeps the hash chain verifiable', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const { verification } = await getVerifiedChain(db, ids[0]);
    expect(verification.ok).toBe(true);
  });

  it('skips a request that is already archived, and writes no second event', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const again = await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    expect(again.archived).toHaveLength(0);
    expect(again.skipped).toEqual([ids[0]]);
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, ids[0]), eq(events.type, 'request.archived')));
    expect(rows).toHaveLength(1);
  });

  it('reports an id that names nothing rather than dropping it', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const res = await archiveRequests(db, {
      requestIds: [ids[0], ghost],
      userId: fixtures.userId,
    });
    expect(res.archived).toEqual([ids[0]]);
    expect(res.skipped).toContain(ghost);
  });

  it('does nothing on an empty selection', async () => {
    const res = await archiveRequests(db, { requestIds: [], userId: fixtures.userId });
    expect(res).toEqual({ archived: [], skipped: [] });
    const after = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(after).toHaveLength(4);
  });

  it('never deletes the request', async () => {
    await archiveRequests(db, { requestIds: ids, userId: fixtures.userId });
    const rows = await db.select().from(reviewRequests);
    expect(rows).toHaveLength(4);
  });

  it('does not SLA-accept an archived request or append sla.timeout', async () => {
    await db
      .update(reviewRequests)
      .set({ slaDueAt: new Date(Date.now() - 1000) })
      .where(eq(reviewRequests.id, ids[0]));
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const n = await applySlaTimeouts(db);
    expect(n).toBe(0);
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].status).toBe('open');
    const timeouts = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, ids[0]), eq(events.type, 'sla.timeout')));
    expect(timeouts).toHaveLength(0);
  });

  it('drops a live lease, then claim/ship/submitVersion refuse the row', async () => {
    await claim(db, ids[0], fixtures.userId);
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const held = await db.select().from(leases).where(eq(leases.requestId, ids[0]));
    expect(held).toHaveLength(0);

    await expect(claim(db, ids[0], fixtures.userId)).rejects.toMatchObject({
      code: 'archived',
      status: 409,
    });
    await expect(
      ship(db, { requestId: ids[0], userId: fixtures.userId, kind: 'approve' })
    ).rejects.toMatchObject({ code: 'archived', status: 409 });
    await expect(
      submitVersion(db, {
        projectId: fixtures.projectId,
        customerRequestId: 'arch/0',
        contentMd: 'a new version that must not land',
      })
    ).rejects.toMatchObject({ code: 'archived', status: 409 });
  });

  it('point-read surfaces archived_at so a poll does not look in-flight', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const res = await getReview(
      new Request('http://localhost/api/v1/review?request_id=arch/0', {
        headers: { authorization: `Bearer ${fixtures.apiToken}` },
      })
    );
    const body = await res.json();
    expect(body.status).toBe('open');
    expect(body.archived_at).toBeTruthy();
  });

  it('changed_since includes the archived row so the cursor cannot stall', async () => {
    const beforeRes = await listReviews(
      new Request('http://localhost/api/v1/reviews?queue=q', {
        headers: { authorization: `Bearer ${fixtures.apiToken}` },
      })
    );
    const before = await beforeRes.json();
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const deltaRes = await listReviews(
      new Request(
        `http://localhost/api/v1/reviews?queue=q&changed_since=${before.max_event_id}`,
        { headers: { authorization: `Bearer ${fixtures.apiToken}` } }
      )
    );
    const delta = await deltaRes.json();
    const archived = delta.reviews.find((r: { id: string }) => r.id === ids[0]);
    expect(archived).toBeTruthy();
    expect(archived.archived_at).toBeTruthy();
    expect(delta.max_event_id).toBeGreaterThan(before.max_event_id);
  });
});
