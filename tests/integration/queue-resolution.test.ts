import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db, client, ensureMigrated, truncateAll, createFixtures, addProject } from './harness';
import { resolveQueue } from '@/lib/core/queue';

/**
 * VOBO-204. A workspace with more than one project could reach only one of
 * them: every page resolved the project with an unordered `findFirst`, so
 * `?queue=<slug>` was silently ignored when that slug lived elsewhere. These
 * tests pin the resolver that replaces those copies.
 */
describe('resolveQueue', () => {
  let workspaceId: number;
  let userId: string;
  let otherWorkspaceId: number;

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    // createFixtures makes project `test` with queue `q`. Alpha and beta are
    // added after it, so `test` is always the deterministic first project.
    const f = await createFixtures();
    workspaceId = f.workspaceId;
    userId = f.userId;
    await addProject(workspaceId, userId, 'alpha', ['alpha-only', 'shared']);
    await addProject(workspaceId, userId, 'beta', ['beta-only', 'shared']);

    const other = await createFixtures();
    otherWorkspaceId = other.workspaceId;
    await addProject(otherWorkspaceId, other.userId, 'secret', ['secret-only']);
  });

  afterAll(async () => {
    await client.end();
  });

  it('finds a unique slug in a project that is not the first', async () => {
    const r = await resolveQueue(db, { workspaceId, queueSlug: 'beta-only' });
    expect(r.queue?.slug).toBe('beta-only');
    expect(r.project?.slug).toBe('beta');
    expect(r.ambiguous).toBe(false);
  });

  it('lets an explicit project win over the slug search', async () => {
    const r = await resolveQueue(db, {
      workspaceId,
      projectSlug: 'beta',
      queueSlug: 'shared',
    });
    expect(r.project?.slug).toBe('beta');
    expect(r.queue?.projectId).toBe(r.project?.id);
  });

  it('reports an ambiguous slug and picks the first project deterministically', async () => {
    const r = await resolveQueue(db, { workspaceId, queueSlug: 'shared' });
    expect(r.queue?.slug).toBe('shared');
    expect(r.project?.slug).toBe('alpha');
    expect(r.ambiguous).toBe(true);
    expect(r.candidateProjects.map((p) => p.slug)).toEqual(['alpha', 'beta']);
  });

  it('returns nothing for an unknown slug, and names the queues that exist', async () => {
    const r = await resolveQueue(db, { workspaceId, queueSlug: 'nope' });
    expect(r.queue).toBeNull();
    expect(r.reason).toBe('queue_not_found');
    expect(r.workspaceQueues.map((q) => q.queueSlug).sort()).toEqual([
      'alpha-only',
      'beta-only',
      'q',
      'shared',
      'shared',
    ]);
  });

  it('reports a project slug that does not exist instead of falling back', async () => {
    const r = await resolveQueue(db, { workspaceId, projectSlug: 'ghost', queueSlug: 'q' });
    expect(r.project).toBeNull();
    expect(r.queue).toBeNull();
    expect(r.reason).toBe('project_not_found');
  });

  it('defaults to the first queue of the first project', async () => {
    const r = await resolveQueue(db, { workspaceId });
    expect(r.project?.slug).toBe('test');
    expect(r.queue?.slug).toBe('q');
    expect(r.reason).toBeNull();
  });

  it('honours the environment', async () => {
    const prod = await resolveQueue(db, { workspaceId, queueSlug: 'beta-only' });
    const test = await resolveQueue(db, {
      workspaceId,
      queueSlug: 'beta-only',
      environment: 'test',
    });
    expect(prod.queue?.environment).toBe('production');
    expect(test.queue?.environment).toBe('test');
    expect(prod.queue?.id).not.toBe(test.queue?.id);
  });

  it('never resolves a queue that belongs to another workspace', async () => {
    const r = await resolveQueue(db, { workspaceId, queueSlug: 'secret-only' });
    expect(r.queue).toBeNull();
    expect(r.reason).toBe('queue_not_found');
  });

  it('returns the same queue on every call — the ordering hole that caused the bug', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await resolveQueue(db, { workspaceId });
      ids.add(r.queue!.id);
    }
    expect(ids.size).toBe(1);
  });

  it('lists every project in the workspace, and the queues of the selected one', async () => {
    const r = await resolveQueue(db, { workspaceId, projectSlug: 'alpha' });
    expect(r.projects.map((p) => p.slug)).toEqual(['test', 'alpha', 'beta']);
    expect(r.projectQueues.map((q) => q.slug).sort()).toEqual(['alpha-only', 'shared']);
  });
});
