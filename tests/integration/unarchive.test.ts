import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { events, reviewRequests, workspaceMembers, user as userTable } from '@/lib/db/schema';
import { createReview } from '@/lib/core/requests';
import {
  archiveRequests,
  unarchiveRequests,
  archivedForQueue,
  rankedQueue,
} from '@/lib/core/queue';
import { getVerifiedChain } from '@/lib/core/eventlog';

let currentUserId: string | null = null;

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@/lib/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/queries')>();
  return {
    ...actual,
    getUser: async () => {
      if (!currentUserId) return null;
      const { db: liveDb } = await import('@/lib/db/drizzle');
      const { user } = await import('@/lib/db/schema');
      const { eq: eqOp } = await import('drizzle-orm');
      const found = await liveDb.select().from(user).where(eqOp(user.id, currentUserId));
      return found[0] ?? null;
    },
  };
});

const { unarchiveRequestsAction } = await import('@/lib/actions/review');

async function addReviewer(workspaceId: number) {
  const id = `u_reviewer_${Math.random().toString(16).slice(2, 8)}`;
  await db.insert(userTable).values({
    id,
    name: 'reviewer',
    email: `${id}@test.local`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(workspaceMembers).values({ userId: id, workspaceId, role: 'reviewer' });
  return id;
}

/**
 * VOBO-245. Unarchive is the exact reversal of archive. The rule that decides
 * everything: archive never touched `status`, so unarchive does not either.
 * A request returns exactly where it was, because anything else would silently
 * discard a decision the pipeline may still be acting on.
 */
describe('unarchiveRequests', () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;
  let ids: string[];

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    currentUserId = null;
    fixtures = await createFixtures();
    ids = [];
    for (let i = 0; i < 3; i++) {
      const { request } = await createReview(db, {
        projectId: fixtures.projectId,
        queueSlug: 'q',
        environment: 'production',
        customerRequestId: `un/${i}`,
        title: `Request ${i}`,
        contentMd: `Body ${i}`,
      });
      ids.push(request.id);
    }
  });

  afterAll(async () => {
    await client.end();
  });

  it('clears both archive columns', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].archivedAt).toBeNull();
    expect(rows[0].archivedBy).toBeNull();
  });

  it('returns an open request to the ranked queue', async () => {
    await archiveRequests(db, { requestIds: [ids[0], ids[1]], userId: fixtures.userId });
    expect(await rankedQueue(db, fixtures.queueId, fixtures.userId)).toHaveLength(1);
    await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const ranked = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(ranked.map((r) => r.request.id).sort()).toEqual([ids[0], ids[2]].sort());
  });

  it('restores the status it held, and does not reset it to open', async () => {
    // The decision that matters. A rejected request the pipeline is still
    // acting on must not silently become open again.
    await db
      .update(reviewRequests)
      .set({ status: 'rejected' })
      .where(eq(reviewRequests.id, ids[0]));
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].status).toBe('rejected');
    // Still off the reviewer queue, because rejected was never on it.
    const ranked = await rankedQueue(db, fixtures.queueId, fixtures.userId);
    expect(ranked.map((r) => r.request.id)).not.toContain(ids[0]);
  });

  it('appends request.unarchived carrying who archived it and when', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    await unarchiveRequests(db, {
      requestIds: [ids[0]],
      userId: fixtures.userId,
      reason: 'archived by mistake',
    });
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, ids[0]), eq(events.type, 'request.unarchived')));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.by).toBe(fixtures.userId);
    expect(payload.archived_by).toBe(fixtures.userId);
    expect(payload.status_restored).toBe('open');
    expect(payload.reason).toBe('archived by mistake');
    expect(typeof payload.archived_at).toBe('string');
  });

  it('keeps the chain verifiable across archive then unarchive', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const { verification, rows } = await getVerifiedChain(db, ids[0]);
    expect(verification.ok).toBe(true);
    // Both events survive. The archive is not erased by the reversal.
    const types = rows.map((r) => r.type);
    expect(types).toContain('request.archived');
    expect(types).toContain('request.unarchived');
  });

  it('skips a request that was never archived, and writes no event', async () => {
    const res = await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    expect(res.unarchived).toHaveLength(0);
    expect(res.skipped).toEqual([ids[0]]);
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, ids[0]), eq(events.type, 'request.unarchived')));
    expect(rows).toHaveLength(0);
  });

  it('is safe to run twice', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const again = await unarchiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    expect(again.unarchived).toHaveLength(0);
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, ids[0]), eq(events.type, 'request.unarchived')));
    expect(rows).toHaveLength(1);
  });

  it('reports an id that names nothing', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    const res = await unarchiveRequests(db, {
      requestIds: [ids[0], ghost],
      userId: fixtures.userId,
    });
    expect(res.unarchived).toEqual([ids[0]]);
    expect(res.skipped).toContain(ghost);
  });

  it('does nothing on an empty selection', async () => {
    const res = await unarchiveRequests(db, { requestIds: [], userId: fixtures.userId });
    expect(res).toEqual({ unarchived: [], skipped: [] });
  });

  it('lists archived requests newest first, and only archived ones', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    await new Promise((r) => setTimeout(r, 5));
    await archiveRequests(db, { requestIds: [ids[2]], userId: fixtures.userId });
    const listed = await archivedForQueue(db, fixtures.queueId);
    expect(listed.map((r) => r.id)).toEqual([ids[2], ids[0]]);
    expect(listed.every((r) => r.archivedAt !== null)).toBe(true);
  });

  it('refuses a reviewer who tries to unarchive, and restores nothing', async () => {
    await archiveRequests(db, { requestIds: [ids[0]], userId: fixtures.userId });
    currentUserId = await addReviewer(fixtures.workspaceId);
    const res = await unarchiveRequestsAction([ids[0]]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('forbidden');
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].archivedAt).toBeInstanceOf(Date);
  });

  it('leaves the listing empty once everything is restored', async () => {
    await archiveRequests(db, { requestIds: ids, userId: fixtures.userId });
    await unarchiveRequests(db, { requestIds: ids, userId: fixtures.userId });
    expect(await archivedForQueue(db, fixtures.queueId)).toHaveLength(0);
    expect(await rankedQueue(db, fixtures.queueId, fixtures.userId)).toHaveLength(3);
  });
});
