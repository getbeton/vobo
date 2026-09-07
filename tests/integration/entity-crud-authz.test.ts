import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { projects, queues, workspaceMembers, user as userTable } from '@/lib/db/schema';

/**
 * VOBO-167 role matrix. Create / rename / archive sit on the operator
 * boundary. Reviewers see no controls because these actions refuse them.
 * getUser is the one mock — same reason as archive-authz.test.ts.
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

const {
  createProjectAction,
  renameProjectAction,
  archiveProjectAction,
  createQueueAction,
  renameQueueAction,
  archiveQueueAction,
} = await import('@/lib/actions/admin');

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

describe('entity CRUD actions — role matrix', () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    currentUserId = null;
    fixtures = await createFixtures();
  });

  afterAll(async () => {
    await client.end();
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await createProjectAction(fixtures.workspaceId, 'X', 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unauthenticated');
  });

  it('reviewer cannot create, rename, or archive', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'reviewer');

    const creates = await Promise.all([
      createProjectAction(fixtures.workspaceId, 'Nope', 'nope'),
      createQueueAction(fixtures.projectId, 'Nope', 'nope-q'),
      renameProjectAction(fixtures.projectId, 'Renamed'),
      renameQueueAction(fixtures.projectId, 'q', 'Renamed'),
      archiveQueueAction(fixtures.projectId, 'q'),
      archiveProjectAction(fixtures.projectId),
    ]);
    for (const res of creates) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('forbidden');
    }

    const [project] = await db.select().from(projects).where(eq(projects.id, fixtures.projectId));
    expect(project.archivedAt).toBeNull();
    expect(project.name).toBe('Test Project');
  });

  it('operator can create, rename, and archive', async () => {
    currentUserId = await addMember(fixtures.workspaceId, 'operator');

    const created = await createProjectAction(fixtures.workspaceId, 'Ops', 'ops');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data?.slug).toBe('ops');

    const renamed = await renameProjectAction(created.data!.id, 'Ops renamed');
    expect(renamed.ok).toBe(true);

    const queue = await createQueueAction(created.data!.id, 'Main', 'main');
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.data?.environments).toHaveLength(2);

    const qRename = await renameQueueAction(created.data!.id, 'main', 'Main line');
    expect(qRename.ok).toBe(true);

    const qArch = await archiveQueueAction(created.data!.id, 'main');
    expect(qArch.ok).toBe(true);
    const qRows = await db
      .select()
      .from(queues)
      .where(eq(queues.projectId, created.data!.id));
    expect(qRows.every((q) => q.archivedAt instanceof Date)).toBe(true);

    const pArch = await archiveProjectAction(created.data!.id);
    expect(pArch.ok).toBe(true);
    const [row] = await db.select().from(projects).where(eq(projects.id, created.data!.id));
    expect(row.archivedAt).toBeInstanceOf(Date);
  });

  it('admin can create, rename, and archive', async () => {
    currentUserId = fixtures.userId;
    const created = await createProjectAction(fixtures.workspaceId, 'Admin', 'admin-p');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await renameProjectAction(created.data!.id, 'Admin 2')).ok).toBe(true);
    expect((await createQueueAction(created.data!.id, 'Q', 'q2')).ok).toBe(true);
    expect((await archiveQueueAction(created.data!.id, 'q2')).ok).toBe(true);
    expect((await archiveProjectAction(created.data!.id)).ok).toBe(true);
  });
});
