import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { createReview } from '@/lib/core/requests';
import { claim, rankedQueue } from '@/lib/core/queue';
import { ship } from '@/lib/core/verdict';
import { setCriterionVerdict } from '@/lib/core/annotations';

/**
 * VOBO-223. A verdict used to end at `router.push('/queue')`, so the reviewer
 * picked the next row by hand — 425 times. "Next" has to be the row the ranking
 * would have offered, and it must never be the request just shipped.
 */
describe('what comes after a verdict', () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;
  let ids: string[];

  const scoreAll = async (requestId: string) => {
    for (const criterionId of fixtures.criterionIds) {
      await setCriterionVerdict(db, {
        requestId,
        criterionId,
        userId: fixtures.userId,
        verdict: 'pass',
      });
    }
  };

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    fixtures = await createFixtures();
    ids = [];
    for (let i = 0; i < 3; i++) {
      const { request } = await createReview(db, {
        projectId: fixtures.projectId,
        queueSlug: 'q',
        environment: 'production',
        customerRequestId: `adv/${i}`,
        // Priority ascending, so the ranking order is deterministic.
        priority: i + 1,
        title: `Request ${i}`,
        contentMd: `Body ${i}`,
      });
      ids.push(request.id);
    }
  });

  afterAll(async () => {
    await client.end();
  });

  it('offers the next ranked request, not the one just shipped', async () => {
    await claim(db, ids[0], fixtures.userId);
    await scoreAll(ids[0]);
    await ship(db, { requestId: ids[0], userId: fixtures.userId, kind: 'approve' });

    const ranked = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(ranked.map((r) => r.request.id)).not.toContain(ids[0]);
    expect(ranked[0].request.id).toBe(ids[1]);
  });

  it('runs out of rows rather than looping', async () => {
    for (const id of ids) {
      await claim(db, id, fixtures.userId);
      await scoreAll(id);
      await ship(db, { requestId: id, userId: fixtures.userId, kind: 'approve' });
    }
    const ranked = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(ranked).toHaveLength(0);
  });

  it('still lists a request another reviewer holds, so the caller can skip it', async () => {
    // rankedQueue never hides a leased row — the reviewer must see why the
    // queue is not empty. Choosing to skip it is the caller's job.
    const other = 'u_other_' + Math.abs(fixtures.workspaceId);
    await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
        values (${other}, 'Other', ${other + '@test.local'}, true, now(), now())`
    );
    await claim(db, ids[1], other);
    const ranked = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    const row = ranked.find((r) => r.request.id === ids[1]);
    expect(row).toBeTruthy();
    expect(row!.lease?.userId).toBe(other);
  });

  it('refuses a rejection at the round-budget wall — escalate stays the exit there', async () => {
    // The engine tells the reviewer to escalate at the wall, so the compare
    // view keeps its Escalate button even though the workspace dropped it.
    // A budget of 1 puts round 1 at the wall without faking a version history.
    const tight = await createFixtures({ roundBudget: 1 });
    const { request } = await createReview(db, {
      projectId: tight.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'adv/budget',
      title: 'At the wall',
      contentMd: 'Body',
    });
    await claim(db, request.id, tight.userId);
    for (const criterionId of tight.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId,
        userId: tight.userId,
        verdict: 'fail',
      });
    }
    await expect(
      ship(db, { requestId: request.id, userId: tight.userId, kind: 'reject_corrections' })
    ).rejects.toMatchObject({ code: 'round_budget_exceeded' });
  });
});
