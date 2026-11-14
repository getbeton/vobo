import { and, eq, isNull } from 'drizzle-orm';
import { projects, queues } from '@/lib/db/schema';
import { ApiProblem } from './requests';
import { ensureProjectTemplate, ensureWorkspaceTemplate, publishQueuePolicy } from './policy-store';
import { slugFromName, isValidSlug } from './slugs';
import type { Db, DbOrTx } from './eventlog';

/**
 * Project and queue CRUD. Workspace rows are created at signup, never from
 * the admin UI. Archive is the only removal — no hard delete. A queue is one
 * user-facing slug with production and test rows, each published to policy v1.
 */

function parseName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ApiProblem(400, 'invalid_name', 'Enter a name');
  if (name.length > 100) throw new ApiProblem(400, 'invalid_name', 'Name is too long');
  return name;
}

function parseSlug(raw: string, fallbackFrom: string): string {
  const slug = slugFromName(raw.trim() ? raw : fallbackFrom);
  if (!isValidSlug(slug)) {
    throw new ApiProblem(
      400,
      'invalid_slug',
      'Use lowercase letters, numbers, and hyphens'
    );
  }
  return slug;
}

function isUniqueViolation(err: unknown): boolean {
  for (let cur: unknown = err, i = 0; cur && i < 5; i++) {
    if (
      typeof cur === 'object' &&
      cur !== null &&
      'code' in cur &&
      (cur as { code: unknown }).code === '23505'
    ) {
      return true;
    }
    cur =
      typeof cur === 'object' && cur !== null && 'cause' in cur
        ? (cur as { cause: unknown }).cause
        : undefined;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate key value violates unique constraint/i.test(msg);
}

function slugCollision(kind: 'project' | 'queue'): never {
  throw new ApiProblem(
    409,
    'slug_collision',
    kind === 'project'
      ? 'A project with this slug already exists'
      : 'A queue with this slug already exists in this project'
  );
}

export async function createProject(
  db: Db,
  input: { workspaceId: number; name: string; slug?: string }
) {
  const name = parseName(input.name);
  const slug = parseSlug(input.slug ?? '', name);

  const existing = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, input.workspaceId), eq(projects.slug, slug)),
  });
  if (existing) slugCollision('project');

  try {
    const [row] = await db
      .insert(projects)
      .values({ workspaceId: input.workspaceId, name, slug })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) slugCollision('project');
    throw err;
  }
}

export async function renameProject(
  db: DbOrTx,
  input: { projectId: string; name: string }
) {
  const name = parseName(input.name);
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, input.projectId),
  });
  if (!project || project.archivedAt) {
    throw new ApiProblem(404, 'project_not_found', 'Project not found');
  }
  const [row] = await db
    .update(projects)
    .set({ name })
    .where(eq(projects.id, input.projectId))
    .returning();
  return row;
}

export async function archiveProject(db: Db, input: { projectId: string }) {
  return db.transaction(async (tx) => {
    const project = await tx.query.projects.findFirst({
      where: eq(projects.id, input.projectId),
    });
    if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
    if (project.archivedAt) {
      throw new ApiProblem(409, 'project_archived', 'Project is archived');
    }
    const at = new Date();
    const [row] = await tx
      .update(projects)
      .set({ archivedAt: at })
      .where(and(eq(projects.id, input.projectId), isNull(projects.archivedAt)))
      .returning();
    await tx
      .update(queues)
      .set({ archivedAt: at })
      .where(and(eq(queues.projectId, input.projectId), isNull(queues.archivedAt)));
    return row;
  });
}

export async function createQueue(
  db: Db,
  input: { projectId: string; name: string; slug?: string; userId: string }
) {
  const name = parseName(input.name);
  const slug = parseSlug(input.slug ?? '', name);

  return db.transaction(async (tx) => {
    const project = await tx.query.projects.findFirst({
      where: eq(projects.id, input.projectId),
    });
    if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
    if (project.archivedAt) {
      throw new ApiProblem(409, 'project_archived', 'Project is archived');
    }

    const existing = await tx.query.queues.findFirst({
      where: and(eq(queues.projectId, input.projectId), eq(queues.slug, slug)),
    });
    if (existing) slugCollision('queue');

    try {
      const wsTemplate = await ensureWorkspaceTemplate(tx, project.workspaceId);
      const projectTemplate = await ensureProjectTemplate(tx, input.projectId, {
        parentTemplateId: wsTemplate.id,
      });
      const made: Array<{ id: string; environment: 'production' | 'test' }> = [];
      for (const environment of ['production', 'test'] as const) {
        const [row] = await tx
          .insert(queues)
          .values({
            projectId: input.projectId,
            name,
            slug,
            environment,
            templateId: projectTemplate.id,
          })
          .returning();
        const published = await publishQueuePolicy(tx, row.id, input.userId);
        made.push({ id: row.id, environment });
        if (!published.policyVersionId) {
          throw new ApiProblem(500, 'queue_unconfigured', 'Queue has no active policy version');
        }
      }
      return { name, slug, environments: made };
    } catch (err) {
      if (err instanceof ApiProblem) throw err;
      if (isUniqueViolation(err)) slugCollision('queue');
      throw err;
    }
  });
}

export async function renameQueue(
  db: DbOrTx,
  input: { projectId: string; slug: string; name: string }
) {
  const name = parseName(input.name);
  const rows = await db
    .select()
    .from(queues)
    .where(
      and(
        eq(queues.projectId, input.projectId),
        eq(queues.slug, input.slug),
        isNull(queues.archivedAt)
      )
    );
  if (rows.length === 0) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');
  await db
    .update(queues)
    .set({ name })
    .where(and(eq(queues.projectId, input.projectId), eq(queues.slug, input.slug)));
  return { name, slug: input.slug, environments: rows.length };
}

export async function archiveQueue(
  db: DbOrTx,
  input: { projectId: string; slug: string }
) {
  const rows = await db
    .select()
    .from(queues)
    .where(and(eq(queues.projectId, input.projectId), eq(queues.slug, input.slug)));
  if (rows.length === 0) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');
  if (rows.every((r) => r.archivedAt)) {
    throw new ApiProblem(409, 'queue_archived', 'Queue is archived');
  }
  const at = new Date();
  await db
    .update(queues)
    .set({ archivedAt: at })
    .where(
      and(
        eq(queues.projectId, input.projectId),
        eq(queues.slug, input.slug),
        isNull(queues.archivedAt)
      )
    );
  return { slug: input.slug, archived: true };
}
