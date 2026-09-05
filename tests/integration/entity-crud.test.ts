import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ensureMigrated, truncateAll, createFixtures, db, client } from './harness';
import { auth } from '@/lib/auth/auth';
import {
  projects,
  queues,
  policyVersions,
  workspaceMembers,
  user as userTable,
} from '@/lib/db/schema';
import {
  archiveProject,
  archiveQueue,
  createProject,
  createQueue,
  renameProject,
  renameQueue,
} from '@/lib/core/entities';
import { createReview, ApiProblem } from '@/lib/core/requests';
import { resolveQueue } from '@/lib/core/queue';

/**
 * VOBO-167. A signup workspace is empty. Operators create projects and
 * queues from that empty state and from a list that already has rows.
 * Archive hides; create-review names the error. Nothing is hard-deleted.
 */

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await client.end();
});

const freshEmail = () => `crud-${randomBytes(4).toString('hex')}@test.local`;

async function signupAdmin() {
  const email = freshEmail();
  await auth.api.signUpEmail({
    body: { email, password: 'correct-horse-battery', name: 'Owner' },
  });
  const u = await db.query.user.findFirst({ where: eq(userTable.email, email) });
  expect(u).toBeTruthy();
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, u!.id));
  return { user: u!, workspaceId: membership.workspaceId };
}

async function liveProjects(workspaceId: number) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)));
}

async function liveQueues(projectId: string) {
  return db
    .select()
    .from(queues)
    .where(and(eq(queues.projectId, projectId), isNull(queues.archivedAt)));
}

describe('signup can create without API or seed', () => {
  it('creates a project then a queue, and create-review works', async () => {
    const { user, workspaceId } = await signupAdmin();
    expect(await liveProjects(workspaceId)).toHaveLength(0);

    const project = await createProject(db, { workspaceId, name: 'PICO', slug: 'pico' });
    expect(project.slug).toBe('pico');
    expect(await liveProjects(workspaceId)).toHaveLength(1);

    const queue = await createQueue(db, {
      projectId: project.id,
      name: 'Cold email',
      slug: 'cold-email',
      userId: user.id,
    });
    expect(queue.slug).toBe('cold-email');
    expect(queue.environments).toHaveLength(2);

    const created = await createReview(db, {
      projectId: project.id,
      queueSlug: 'cold-email',
      environment: 'production',
      customerRequestId: 'pico/first',
      title: 'First',
      contentMd: 'Hello.',
    });
    expect(created.created).toBe(true);
  });

  it('creates a second project and queue from a non-empty list', async () => {
    const { user, workspaceId } = await signupAdmin();
    const first = await createProject(db, { workspaceId, name: 'One', slug: 'one' });
    await createQueue(db, {
      projectId: first.id,
      name: 'Inbox',
      slug: 'inbox',
      userId: user.id,
    });

    const second = await createProject(db, { workspaceId, name: 'Two', slug: 'two' });
    await createQueue(db, {
      projectId: first.id,
      name: 'Review',
      slug: 'review',
      userId: user.id,
    });
    await createQueue(db, {
      projectId: second.id,
      name: 'Inbox',
      slug: 'inbox',
      userId: user.id,
    });

    const listed = await liveProjects(workspaceId);
    expect(listed.map((p) => p.slug).sort()).toEqual(['one', 'two']);
    expect((await liveQueues(first.id)).map((q) => q.slug).sort()).toEqual([
      'inbox',
      'inbox',
      'review',
      'review',
    ]);
  });
});

describe('queue create twins', () => {
  it('writes production and test rows sharing one slug, each with an active policy version', async () => {
    const fx = await createFixtures();
    const made = await createQueue(db, {
      projectId: fx.projectId,
      name: 'Support',
      slug: 'support',
      userId: fx.userId,
    });
    expect(made.environments.map((e) => e.environment).sort()).toEqual(['production', 'test']);

    const rows = await db
      .select()
      .from(queues)
      .where(and(eq(queues.projectId, fx.projectId), eq(queues.slug, 'support')));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.slug))).toEqual(new Set(['support']));
    expect(rows.every((r) => r.activePolicyVersionId)).toBe(true);
    expect(rows[0].activePolicyVersionId).not.toBe(rows[1].activePolicyVersionId);

    for (const row of rows) {
      const [pv] = await db
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.id, row.activePolicyVersionId!));
      expect(pv.queueId).toBe(row.id);
      expect(pv.version).toBe(1);
    }
  });
});

describe('slug collision', () => {
  it('rejects a duplicate project slug with a readable error', async () => {
    const fx = await createFixtures();
    await createProject(db, { workspaceId: fx.workspaceId, name: 'Alpha', slug: 'alpha' });
    await expect(
      createProject(db, { workspaceId: fx.workspaceId, name: 'Alpha two', slug: 'alpha' })
    ).rejects.toMatchObject({
      status: 409,
      code: 'slug_collision',
      message: 'A project with this slug already exists',
    });
  });

  it('rejects a duplicate queue slug with a readable error', async () => {
    const fx = await createFixtures();
    await createQueue(db, {
      projectId: fx.projectId,
      name: 'Support',
      slug: 'support',
      userId: fx.userId,
    });
    await expect(
      createQueue(db, {
        projectId: fx.projectId,
        name: 'Support 2',
        slug: 'support',
        userId: fx.userId,
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'slug_collision',
      message: 'A queue with this slug already exists in this project',
    });
  });

  it('still collides after archive — slugs are not recycled', async () => {
    const fx = await createFixtures();
    const project = await createProject(db, {
      workspaceId: fx.workspaceId,
      name: 'Gone',
      slug: 'gone',
    });
    await archiveProject(db, { projectId: project.id });
    await expect(
      createProject(db, { workspaceId: fx.workspaceId, name: 'Gone again', slug: 'gone' })
    ).rejects.toMatchObject({ code: 'slug_collision' });
  });
});

describe('archive then submit', () => {
  it('hides the queue and names create-review queue_archived', async () => {
    const fx = await createFixtures();
    await createQueue(db, {
      projectId: fx.projectId,
      name: 'Support',
      slug: 'support',
      userId: fx.userId,
    });
    await archiveQueue(db, { projectId: fx.projectId, slug: 'support' });

    expect((await liveQueues(fx.projectId)).map((q) => q.slug).sort()).toEqual(['q', 'q']);
    const resolved = await resolveQueue(db, {
      workspaceId: fx.workspaceId,
      queueSlug: 'support',
    });
    expect(resolved.queue).toBeNull();

    await expect(
      createReview(db, {
        projectId: fx.projectId,
        queueSlug: 'support',
        environment: 'production',
        customerRequestId: 'after/archive',
        title: 'Nope',
        contentMd: 'Nope',
      })
    ).rejects.toMatchObject({ status: 409, code: 'queue_archived' });
  });

  it('hides the project and names create-review project_archived', async () => {
    const fx = await createFixtures();
    await archiveProject(db, { projectId: fx.projectId });

    expect(await liveProjects(fx.workspaceId)).toHaveLength(0);
    const resolved = await resolveQueue(db, { workspaceId: fx.workspaceId });
    expect(resolved.project).toBeNull();
    expect(resolved.reason).toBe('no_projects');

    const err = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'after/project-archive',
      title: 'Nope',
      contentMd: 'Nope',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect(err.code).toBe('project_archived');
  });

  it('leaves the row in place — archive is not a delete', async () => {
    const fx = await createFixtures();
    await archiveProject(db, { projectId: fx.projectId });
    const [row] = await db.select().from(projects).where(eq(projects.id, fx.projectId));
    expect(row).toBeTruthy();
    expect(row.archivedAt).toBeInstanceOf(Date);
    const queueRows = await db.select().from(queues).where(eq(queues.projectId, fx.projectId));
    expect(queueRows.length).toBeGreaterThan(0);
    expect(queueRows.every((q) => q.archivedAt instanceof Date)).toBe(true);
  });
});

describe('rename', () => {
  it('renames a project and both environment rows of a queue', async () => {
    const fx = await createFixtures();
    const renamed = await renameProject(db, { projectId: fx.projectId, name: 'New name' });
    expect(renamed.name).toBe('New name');
    expect(renamed.slug).toBe('test');

    await renameQueue(db, { projectId: fx.projectId, slug: 'q', name: 'Main' });
    const rows = await db
      .select()
      .from(queues)
      .where(and(eq(queues.projectId, fx.projectId), eq(queues.slug, 'q')));
    expect(rows.every((r) => r.name === 'Main')).toBe(true);
  });
});
