import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { eq } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { user as userTable, workspaces, workspaceMembers, projects } from '@/lib/db/schema';

/**
 * VOBO-207. `db:seed:demo` took the owner's first membership and wrote its
 * fixtures there. Pointed at production, it put three people who do not exist
 * on the live workspace page. The seed must own its workspace and must refuse
 * a live one.
 */
const DEMO_EMAILS = ['mara@betonlabs.dev', 'jonas@betonlabs.dev', 'ana@betonlabs.dev'];

function runSeed(env: Record<string, string> = {}) {
  try {
    const out = execFileSync('npx', ['tsx', 'lib/db/seed-demo.ts'], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('demo seed guard', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await client.end();
  });

  it('refuses a workspace that holds work it did not create', async () => {
    const f = await createFixtures();
    // Make the fixture user look like the seed owner, and give the workspace a
    // slug that is not the demo one.
    await db
      .update(userTable)
      .set({ email: 'owner@test.local' })
      .where(eq(userTable.id, f.userId));
    await db
      .update(workspaces)
      .set({ slug: 'beton-labs' })
      .where(eq(workspaces.id, f.workspaceId));

    const before = await db.select().from(workspaceMembers);
    const r = runSeed({
      SEED_EMAIL: 'owner@test.local',
      VOBO_DEMO_WORKSPACE_ID: String(f.workspaceId),
    });

    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Refusing to seed the demo/);
    expect(r.out).toMatch(/project\(s\)/);

    const after = await db.select().from(workspaceMembers);
    expect(after.length).toBe(before.length);
    const demoUsers = await db.select().from(userTable);
    expect(demoUsers.filter((u) => DEMO_EMAILS.includes(u.email))).toHaveLength(0);
  });

  it('writes into its own workspace, and leaves the live one alone', async () => {
    const f = await createFixtures();
    await db
      .update(userTable)
      .set({ email: 'owner@test.local' })
      .where(eq(userTable.id, f.userId));
    await db
      .update(workspaces)
      .set({ slug: 'beton-labs' })
      .where(eq(workspaces.id, f.workspaceId));

    const r = runSeed({ SEED_EMAIL: 'owner@test.local' });
    expect(r.code).toBe(0);

    const demoWs = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, 'vobo-demo'),
    });
    expect(demoWs).toBeTruthy();

    // The live workspace keeps exactly the one member it had.
    const liveMembers = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, f.workspaceId));
    expect(liveMembers).toHaveLength(1);

    // Every demo project landed in the demo workspace.
    const demoProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, demoWs!.id));
    expect(demoProjects.map((p) => p.slug).sort()).toEqual(['acme', 'pico']);

    const liveProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, f.workspaceId));
    expect(liveProjects.map((p) => p.slug)).toEqual(['test']);
  }, 120000);

  it('is idempotent — a second run adds nothing', async () => {
    const f = await createFixtures();
    await db
      .update(userTable)
      .set({ email: 'owner@test.local' })
      .where(eq(userTable.id, f.userId));

    expect(runSeed({ SEED_EMAIL: 'owner@test.local' }).code).toBe(0);
    const first = await db.select().from(projects);

    const second = runSeed({ SEED_EMAIL: 'owner@test.local' });
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/already present/);

    const after = await db.select().from(projects);
    expect(after.length).toBe(first.length);
  }, 180000);

  it('writes into a live workspace only when forced', async () => {
    const f = await createFixtures();
    await db
      .update(userTable)
      .set({ email: 'owner@test.local' })
      .where(eq(userTable.id, f.userId));
    await db
      .update(workspaces)
      .set({ slug: 'beton-labs' })
      .where(eq(workspaces.id, f.workspaceId));

    const r = runSeed({
      SEED_EMAIL: 'owner@test.local',
      VOBO_DEMO_WORKSPACE_ID: String(f.workspaceId),
      VOBO_DEMO_FORCE: '1',
    });
    expect(r.code).toBe(0);

    const members = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, f.workspaceId));
    expect(members.length).toBeGreaterThan(1);
  }, 120000);
});
