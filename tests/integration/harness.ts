import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { db, client } from '@/lib/db/drizzle';
import {
  user,
  workspaces,
  workspaceMembers,
  projects,
  queues,
  policyVersions,
  criteria,
  apiKeys,
} from '@/lib/db/schema';
import { DEFAULT_POLICY, DEFAULT_TEMPLATE_SLUG, PolicyConfig } from '@/lib/core/policy';
import { ensureProjectTemplate, ensureWorkspaceTemplate } from '@/lib/core/policy-store';
import { createHash, randomBytes } from 'crypto';

let migrated = false;

export async function ensureMigrated() {
  if (migrated) return;
  await migrate(db, { migrationsFolder: 'lib/db/migrations' });
  migrated = true;
}

export async function truncateAll() {
  const tables = await db.execute(sql`
    select tablename from pg_tables
    where schemaname = 'public'
  `);
  const names = (tables as unknown as Array<{ tablename: string }>)
    .map((t) => `"${t.tablename}"`)
    .join(', ');
  if (names.length) {
    await db.execute(sql.raw(`truncate table ${names} restart identity cascade`));
  }
}

export interface Fixtures {
  userId: string;
  workspaceId: number;
  projectId: string;
  queueId: string;
  testQueueId: string;
  policyVersionId: string;
  workspaceTemplateId: string;
  projectTemplateId: string;
  templateSlug: string;
  criterionIds: string[];
  apiToken: string;
}

export async function createFixtures(policyOverrides: Partial<PolicyConfig> = {}): Promise<Fixtures> {
  const userId = 'u_test_' + randomBytes(4).toString('hex');
  await db.insert(user).values({
    id: userId,
    name: 'Test Reviewer',
    email: `${userId}@test.local`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const [ws] = await db
    .insert(workspaces)
    .values({ name: 'Test WS', slug: 'test-ws-' + randomBytes(3).toString('hex') })
    .returning();
  await db.insert(workspaceMembers).values({ userId, workspaceId: ws.id, role: 'admin' });

  const [project] = await db
    .insert(projects)
    .values({ workspaceId: ws.id, name: 'Test Project', slug: 'test' })
    .returning();

  const wsTemplate = await ensureWorkspaceTemplate(db, ws.id);
  const projectTemplate = await ensureProjectTemplate(db, project.id, {
    parentTemplateId: wsTemplate.id,
  });

  const mk = async (environment: 'production' | 'test') => {
    const [queue] = await db
      .insert(queues)
      .values({
        projectId: project.id,
        name: 'q',
        slug: 'q',
        environment,
        templateId: projectTemplate.id,
      })
      .returning();
    const [pv] = await db
      .insert(policyVersions)
      .values({
        queueId: queue.id,
        templateId: projectTemplate.id,
        version: 1,
        config: { ...DEFAULT_POLICY, ...policyOverrides },
        createdBy: userId,
      })
      .returning();
    await db.update(queues).set({ activePolicyVersionId: pv.id }).where(sql`${queues.id} = ${queue.id}`);
    return { queue, pv };
  };

  const prod = await mk('production');
  const test = await mk('test');

  const crits = await db
    .insert(criteria)
    .values([
      { queueId: prod.queue.id, key: 'voice', title: 'Voice', position: 0 },
      { queueId: prod.queue.id, key: 'factual', title: 'Factual', position: 1 },
    ])
    .returning();

  const token = 'vobo_sk_test_' + randomBytes(12).toString('base64url');
  await db.insert(apiKeys).values({
    projectId: project.id,
    name: 'test-key',
    keyHash: createHash('sha256').update(token).digest('hex'),
    keyPrefix: token.slice(0, 12),
  });

  return {
    userId,
    workspaceId: ws.id,
    projectId: project.id,
    queueId: prod.queue.id,
    testQueueId: test.queue.id,
    policyVersionId: prod.pv.id,
    workspaceTemplateId: wsTemplate.id,
    projectTemplateId: projectTemplate.id,
    templateSlug: DEFAULT_TEMPLATE_SLUG,
    criterionIds: crits.map((c) => c.id),
    apiToken: token,
  };
}

export { db, client };

/**
 * A second project with its own queues, for the multi-project resolution tests.
 * The production defect was that only the first project of a workspace was ever
 * reachable, so every test of the resolver needs at least two.
 */
export async function addProject(
  workspaceId: number,
  userId: string,
  slug: string,
  queueSlugs: string[]
) {
  const [project] = await db
    .insert(projects)
    .values({ workspaceId, name: slug, slug })
    .returning();
  const wsTemplate = await ensureWorkspaceTemplate(db, workspaceId);
  const projectTemplate = await ensureProjectTemplate(db, project.id, {
    parentTemplateId: wsTemplate.id,
  });
  const made: Record<string, { production: string; test: string }> = {};
  for (const queueSlug of queueSlugs) {
    const pair: Record<string, string> = {};
    for (const environment of ['production', 'test'] as const) {
      const [queue] = await db
        .insert(queues)
        .values({
          projectId: project.id,
          name: queueSlug,
          slug: queueSlug,
          environment,
          templateId: projectTemplate.id,
        })
        .returning();
      const [pv] = await db
        .insert(policyVersions)
        .values({
          queueId: queue.id,
          templateId: projectTemplate.id,
          version: 1,
          config: DEFAULT_POLICY,
          createdBy: userId,
        })
        .returning();
      await db
        .update(queues)
        .set({ activePolicyVersionId: pv.id })
        .where(sql`${queues.id} = ${queue.id}`);
      pair[environment] = queue.id;
    }
    made[queueSlug] = pair as { production: string; test: string };
  }
  return { project, queues: made };
}
