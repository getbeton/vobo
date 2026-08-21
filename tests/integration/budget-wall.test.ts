import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { events, reviewRequests, user, workspaceMembers } from '@/lib/db/schema';
import { createReview } from '@/lib/core/requests';
import { claim } from '@/lib/core/queue';
import { ship } from '@/lib/core/verdict';
import { setCriterionVerdict } from '@/lib/core/annotations';
import { getVerifiedChain } from '@/lib/core/eventlog';
import {
  exportFailingCsv,
  failingRowsToCsv,
  listFailingForOperator,
  listFailingRequests,
} from '@/lib/core/failing';

/**
 * VOBO-237. Escalate is gone from the UI. A reject at round == roundBudget
 * ships as a normal reject and flags the request for an operator. Approve at
 * the wall still accepts and does not flag. The engine keeps the escalate
 * kind because the four-state pull contract publishes it.
 */
describe('the round-budget wall after Escalate leaves the UI', () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;
  let requestId: string;

  const scoreAll = async (id: string, verdict: 'pass' | 'fail') => {
    for (const criterionId of fixtures.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: id,
        criterionId,
        userId: fixtures.userId,
        verdict,
      });
    }
  };

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    // A budget of 1 puts round 1 at the wall without faking a version history.
    fixtures = await createFixtures({ roundBudget: 1 });
    const { request } = await createReview(db, {
      projectId: fixtures.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'wall/one',
      title: 'At the wall',
      contentMd: 'Body',
    });
    requestId = request.id;
    await claim(db, requestId, fixtures.userId);
  });

  afterAll(async () => {
    await client.end();
  });

  it('ships a reject at the wall, flags the request, and keeps acceptedHash null', async () => {
    await scoreAll(requestId, 'fail');
    const res = await ship(db, {
      requestId,
      userId: fixtures.userId,
      kind: 'reject_rerun',
    });
    expect(res.status).toBe('rejected');

    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, requestId));
    expect(rows[0].status).toBe('rejected');
    expect(rows[0].acceptedHash).toBeNull();
    expect(rows[0].budgetExhaustedAt).toBeInstanceOf(Date);
    expect(rows[0].budgetExhaustedBy).toBe(fixtures.userId);

    const chain = await db.select().from(events).where(eq(events.requestId, requestId));
    const flagged = chain.find((r) => r.type === 'request.budget_exhausted');
    expect(flagged).toBeTruthy();
    const payload = flagged!.payload as Record<string, unknown>;
    expect(payload.by).toBe(fixtures.userId);
    expect(payload.round).toBe(1);
    expect(payload.round_budget).toBe(1);
    expect(payload.kind).toBe('reject_rerun');

    const { verification } = await getVerifiedChain(db, requestId);
    expect(verification.ok).toBe(true);
  });

  it('refuses a further reject once flagged — the loop is over', async () => {
    await scoreAll(requestId, 'fail');
    await ship(db, { requestId, userId: fixtures.userId, kind: 'reject_rerun' });
    await expect(
      ship(db, { requestId, userId: fixtures.userId, kind: 'reject_rerun' })
    ).rejects.toMatchObject({ code: 'round_budget_exceeded' });

    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, requestId));
    expect(rows[0].budgetExhaustedAt).toBeInstanceOf(Date);
    expect(rows[0].status).toBe('rejected');
  });

  it('lets approve through at the wall and does not flag', async () => {
    await scoreAll(requestId, 'pass');
    const res = await ship(db, {
      requestId,
      userId: fixtures.userId,
      kind: 'approve',
    });
    expect(res.status).toBe('accepted');

    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, requestId));
    expect(rows[0].status).toBe('accepted');
    expect(rows[0].acceptedHash).toBeTruthy();
    expect(rows[0].budgetExhaustedAt).toBeNull();

    const chain = await db.select().from(events).where(eq(events.requestId, requestId));
    expect(chain.find((r) => r.type === 'request.budget_exhausted')).toBeUndefined();
  });

  it('an operator can list failing requests and a reviewer cannot', async () => {
    await scoreAll(requestId, 'fail');
    await ship(db, { requestId, userId: fixtures.userId, kind: 'reject_rerun' });

    const listed = await listFailingForOperator(db, {
      userId: fixtures.userId,
      workspaceId: fixtures.workspaceId,
      queueId: fixtures.queueId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(requestId);
    expect(listed[0].lastDecisionKind).toBe('reject_rerun');
    expect(listed[0].roundBudget).toBe(1);

    const reviewerId = 'u_rev_' + randomBytes(4).toString('hex');
    await db.insert(user).values({
      id: reviewerId,
      name: 'Reviewer',
      email: `${reviewerId}@test.local`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(workspaceMembers)
      .values({ userId: reviewerId, workspaceId: fixtures.workspaceId, role: 'reviewer' });

    await expect(
      listFailingForOperator(db, {
        userId: reviewerId,
        workspaceId: fixtures.workspaceId,
        queueId: fixtures.queueId,
      })
    ).rejects.toMatchObject({ code: 'forbidden' });

    // The list itself is still there; the gate is the role check.
    const all = await listFailingRequests(db, { queueId: fixtures.queueId });
    expect(all).toHaveLength(1);
  });

  it('CSV export returns a row for the flagged request, RFC4180-quoted', async () => {
    await scoreAll(requestId, 'fail');
    await ship(db, { requestId, userId: fixtures.userId, kind: 'reject_rerun' });

    const csv = await exportFailingCsv(db, { queueId: fixtures.queueId });
    expect(csv).toContain('id,title,status,round,roundBudget,queue,flagged_at,last_decision_kind,customer_request_id');
    expect(csv).toContain(requestId);
    expect(csv).toContain('At the wall');
    expect(csv).toContain('reject_rerun');
    expect(csv).toContain('wall/one');

    const quoted = failingRowsToCsv([
      {
        id: 'id-1',
        title: 'Title, with comma',
        status: 'rejected',
        round: 1,
        roundBudget: 1,
        queueSlug: 'q',
        flaggedAt: new Date('2026-08-21T12:00:00.000Z'),
        lastDecisionKind: 'reject_rerun',
        customerRequestId: 'c,1',
        archivedAt: null,
      },
    ]);
    expect(quoted).toContain('"Title, with comma"');
    expect(quoted).toContain('"c,1"');
  });

  it('the engine still accepts an escalate decision — only the UI dropped it', async () => {
    // The four-state pull contract (VOBO-194) publishes `escalated`, and
    // production rows carry it. Removing the enum value would break both.
    await scoreAll(requestId, 'fail');
    const res = await ship(db, {
      requestId,
      userId: fixtures.userId,
      kind: 'escalate',
      reason: 'needs an operator ruling',
    });
    expect(res.status).toBe('escalated');
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, requestId));
    expect(rows[0].status).toBe('escalated');
    expect(rows[0].budgetExhaustedAt).toBeNull();
  });
});
