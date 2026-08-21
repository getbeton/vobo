import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq, isNotNull } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { reviewRequests, workspaceMembers, user as userTable } from '@/lib/db/schema';
import { createReview } from '@/lib/core/requests';

/**
 * VOBO-244. The 9 tests in tests/integration/archive.test.ts cover
 * `archiveRequests`, the core function. They do NOT reach
 * `archiveRequestsAction`, and the action is where the role guard and the
 * cross-workspace guard live. Those two rules are the security boundary of the
 * feature, so they get their own tests.
 *
 * The action reads the caller through `getUser()`, which resolves a BetterAuth
 * session from request headers. There is no request here, so `getUser` is the
 * one thing mocked. Everything under it — `can.operate`, `requireRole`,
 * `workspaceOfRequest`, `archiveRequests` — runs for real against Postgres.
 */

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

const { archiveRequestsAction } = await import('@/lib/actions/review');

async function addMember(
  workspaceId: number,
  role: 'reviewer' | 'operator' | 'admin' | 'adjudicator'
) {
  const id = `u_${role}_${Math.random().toString(16).slice(2, 8)}`;
  await db.insert(userTable).values({
    id,
    name: role,
    email: `${id}@test.local`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(workspaceMembers).values({ userId: id, workspaceId, role });
  return id;
}

async function archivedCount() {
  const rows = await db
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(isNotNull(reviewRequests.archivedAt));
  return rows.length;
}

describe('archiveRequestsAction — authorization', () => {
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
        customerRequestId: `authz/${i}`,
        title: `Request ${i}`,
        contentMd: `Body ${i}`,
      });
      ids.push(request.id);
    }
  });

  afterAll(async () => {
    await client.end();
  });

  it('refuses a reviewer, and archives nothing', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'reviewer');
    const res = await archiveRequestsAction([ids[0], ids[1]]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('forbidden');
    expect(await archivedCount()).toBe(0);
  });

  it('refuses an adjudicator — operate is not implied by adjudicate', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'adjudicator');
    const res = await archiveRequestsAction([ids[0]]);
    expect(res.ok).toBe(false);
    expect(await archivedCount()).toBe(0);
  });

  it('lets an operator through', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'operator');
    const res = await archiveRequestsAction([ids[0], ids[1]]);
    expect(res.ok).toBe(true);
    expect(await archivedCount()).toBe(2);
  });

  it('lets an admin through — admin can do anything an operator can', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'admin');
    const res = await archiveRequestsAction([ids[0]]);
    expect(res.ok).toBe(true);
    expect(await archivedCount()).toBe(1);
  });

  it('refuses a signed-out caller', async () => {
    currentUserId = null;
    const res = await archiveRequestsAction([ids[0]]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unauthenticated');
    expect(await archivedCount()).toBe(0);
  });

  it('refuses an empty selection', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'operator');
    const res = await archiveRequestsAction([]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('nothing_selected');
  });

  it('refuses a member of another workspace, even for a valid id', async () => {
    const other = await createFixtures();
    currentUserId = await addMember(other.workspaceId, 'operator');
    const res = await archiveRequestsAction([ids[0]]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_a_member');
    expect(await archivedCount()).toBe(0);
  });

  it('refuses a batch that spans two workspaces, and archives NOTHING', async () => {
    // The failure that matters. The guard runs on the first id only, so an
    // attacker would append a foreign id and ride in on that one check. The
    // refusal has to land before the first write, not part-way through.
    const other = await createFixtures();
    const { request: foreign } = await createReview(db, {
      projectId: other.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'authz/foreign',
      title: 'Foreign request',
      contentMd: 'Body',
    });
    currentUserId = await addMember(fixtures.workspaceId, 'operator');

    const res = await archiveRequestsAction([ids[0], ids[1], foreign.id]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('cross_workspace');

    // Neither the caller's own requests nor the foreign one may be touched.
    expect(await archivedCount()).toBe(0);
    const foreignRow = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, foreign.id));
    expect(foreignRow[0].archivedAt).toBeNull();
  });

  it('refuses when the first id is the foreign one', async () => {
    // Order must not decide the outcome. The caller is an operator of the
    // first id's workspace, so guardOperator succeeds and the loop is what
    // must refuse. A local operator with foreign-first dies at not_a_member
    // before requestIds.slice(1) and never proves the loop.
    const other = await createFixtures();
    const { request: foreign } = await createReview(db, {
      projectId: other.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'authz/foreign-first',
      title: 'Foreign first',
      contentMd: 'Body',
    });
    currentUserId = await addMember(other.workspaceId, 'operator');

    const res = await archiveRequestsAction([foreign.id, ids[0]]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('cross_workspace');
    expect(await archivedCount()).toBe(0);
    const localRow = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(localRow[0].archivedAt).toBeNull();
    const foreignRow = await db.select().from(reviewRequests).where(eq(reviewRequests.id, foreign.id));
    expect(foreignRow[0].archivedAt).toBeNull();
  });

  it('stamps the acting user, not the request author', async () => {
    const operator = await addMember(fixtures.workspaceId, 'operator');
    currentUserId = operator;
    await archiveRequestsAction([ids[0]]);
    const rows = await db.select().from(reviewRequests).where(eq(reviewRequests.id, ids[0]));
    expect(rows[0].archivedBy).toBe(operator);
  });
});
