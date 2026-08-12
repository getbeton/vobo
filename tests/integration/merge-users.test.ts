import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { user as userTable, workspaceMembers, decisions, annotations } from '@/lib/db/schema';
import { createReview } from '@/lib/core/requests';
import { claim } from '@/lib/core/queue';
import { addComment, setCriterionVerdict } from '@/lib/core/annotations';
import { ship } from '@/lib/core/verdict';

const run = promisify(execFile);

/**
 * VOBO-168 — merging a pair that already diverged. The point of the script is
 * attribution: a decision that loses its author stops answering "who accepted
 * this", which is the whole promise of the Timeline.
 */

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({ roundBudget: 3, slaMinutes: null });
});

async function makeDuplicate() {
  const id = 'u_dup_' + randomBytes(4).toString('hex');
  await db.insert(userTable).values({
    id,
    name: 'Duplicate Identity',
    email: `${id}@test.local`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(workspaceMembers).values({
    userId: id,
    workspaceId: fx.workspaceId,
    role: 'reviewer',
  });
  return id;
}

/** Work authored by the duplicate identity: a comment and a shipped verdict. */
async function authorWork(userId: string) {
  const { request } = await createReview(db, {
    projectId: fx.projectId,
    queueSlug: 'q',
    environment: 'production',
    customerRequestId: `merge/${randomBytes(3).toString('hex')}`,
    title: 'Work by the duplicate',
    contentMd: 'Hello there, this is the artifact under review.',
  });
  await claim(db, request.id, userId);
  await addComment(db, {
    requestId: request.id,
    userId,
    body: 'This opener is wrong.',
    expected: 'Open on the situation.',
    startPos: 0,
    endPos: 11,
  });
  for (const criterionId of fx.criterionIds) {
    await setCriterionVerdict(db, { requestId: request.id, criterionId, userId, verdict: 'fail' });
  }
  await ship(db, { requestId: request.id, userId, kind: 'reject_corrections' });
  return request.id;
}

const script = (args: string[]) =>
  run('node', ['scripts/merge-users.mjs', ...args], {
    env: { ...process.env, POSTGRES_URL: process.env.POSTGRES_URL! },
  });

describe('merge-users script', () => {
  it('dry-run reports the rows and changes NOTHING', async () => {
    const dup = await makeDuplicate();
    await authorWork(dup);

    const { stdout } = await script(['--keep', fx.userId, '--merge', dup]);
    expect(stdout).toContain('DRY RUN');
    expect(stdout).toMatch(/decisions\.decided_by/);
    expect(stdout).toMatch(/annotations\.author_user_id/);

    // Still two users, and the work still belongs to the duplicate.
    expect(await db.select().from(userTable)).toHaveLength(2);
    const stillTheirs = await db.select().from(decisions).where(eq(decisions.decidedBy, dup));
    expect(stillTheirs.length).toBeGreaterThan(0);
  });

  it('--apply moves authorship to the survivor and retires the duplicate', async () => {
    const dup = await makeDuplicate();
    await authorWork(dup);

    await script(['--keep', fx.userId, '--merge', dup, '--apply']);

    expect(await db.query.user.findFirst({ where: eq(userTable.id, dup) })).toBeFalsy();

    // Attribution moved rather than vanished — no orphaned decisions.
    expect(await db.select().from(decisions).where(eq(decisions.decidedBy, dup))).toHaveLength(0);
    expect(
      (await db.select().from(decisions).where(eq(decisions.decidedBy, fx.userId))).length
    ).toBeGreaterThan(0);
    expect(
      (await db.select().from(annotations).where(eq(annotations.authorUserId, fx.userId))).length
    ).toBeGreaterThan(0);
  });

  it('does not duplicate a membership both identities already held', async () => {
    const dup = await makeDuplicate(); // same workspace as fx.userId
    await script(['--keep', fx.userId, '--merge', dup, '--apply']);

    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, fx.userId));
    expect(rows).toHaveLength(1);
  });

  it('refuses to merge a user into itself', async () => {
    await expect(script(['--keep', fx.userId, '--merge', fx.userId])).rejects.toThrow();
  });
});
