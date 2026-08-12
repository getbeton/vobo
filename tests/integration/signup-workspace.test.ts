import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ensureMigrated, truncateAll, db } from './harness';
import { auth } from '@/lib/auth/auth';
import { ensurePersonalWorkspace, assignWorkspaceOnSignup } from '@/lib/auth/bootstrap';
import {
  user as userTable,
  workspaceMembers,
  workspaces,
  invitations,
} from '@/lib/db/schema';

/**
 * The invariant: no signup may end without a workspace. A user without one
 * bounces off every workspace-scoped page, so this is enforced in the
 * user-create hook — the single point every path goes through — rather than in
 * any one sign-up flow.
 */

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
});

const freshEmail = () => `signup-${randomBytes(4).toString('hex')}@test.local`;

async function membershipsFor(email: string) {
  const u = await db.query.user.findFirst({ where: eq(userTable.email, email) });
  expect(u, 'user row').toBeTruthy();
  return db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, u!.id));
}

describe('every signup lands in a workspace', () => {
  it('email + password signup creates one, owned as admin', async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Test' },
    });

    const rows = await membershipsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');

    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, rows[0].workspaceId),
    });
    expect(ws!.name).toContain(email.split('@')[0]);
  });

  it('the hook fires on user creation, not inside a particular sign-up flow', async () => {
    // Social sign-in never touches the sign-up server action, and its callback
    // may redirect anywhere — so the guarantee cannot live in that action.
    // Creating a user through the adapter directly must still yield a workspace.
    const email = freshEmail();
    const ctx = await auth.$context;
    await ctx.internalAdapter.createUser({
      email,
      name: 'Social User',
      emailVerified: true,
    });

    const rows = await membershipsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
  });

  it('is idempotent — a repeated callback cannot mint a second workspace', async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Test' },
    });
    const u = await db.query.user.findFirst({ where: eq(userTable.email, email) });

    await ensurePersonalWorkspace(u!.id, email);
    await ensurePersonalWorkspace(u!.id, email);

    expect(await membershipsFor(email)).toHaveLength(1);
  });

  it('workspace slugs stay unique when two people share a local part', async () => {
    const a = `dup-${randomBytes(3).toString('hex')}@one.test`;
    const b = a.replace('@one.test', '@two.test');
    for (const email of [a, b]) {
      await auth.api.signUpEmail({
        body: { email, password: 'correct-horse-battery', name: 'Dup' },
      });
    }
    const rowsA = await membershipsFor(a);
    const rowsB = await membershipsFor(b);
    expect(rowsA[0].workspaceId).not.toBe(rowsB[0].workspaceId);
  });

  describe('invitations', () => {
    async function invite(email: string, role: 'reviewer' | 'operator' = 'reviewer') {
      const inviterEmail = freshEmail();
      await auth.api.signUpEmail({
        body: { email: inviterEmail, password: 'correct-horse-battery', name: 'Inviter' },
      });
      const [inviterMembership] = await membershipsFor(inviterEmail);
      await db.insert(invitations).values({
        workspaceId: inviterMembership.workspaceId,
        email,
        role,
        invitedBy: (await db.query.user.findFirst({
          where: eq(userTable.email, inviterEmail),
        }))!.id,
      });
      return inviterMembership.workspaceId;
    }

    it('an invited signup joins the inviting workspace and gets NO personal one', async () => {
      const email = freshEmail();
      const workspaceId = await invite(email, 'reviewer');

      await auth.api.signUpEmail({
        body: { email, password: 'correct-horse-battery', name: 'Invited' },
      });

      const rows = await membershipsFor(email);
      expect(rows).toHaveLength(1);
      expect(rows[0].workspaceId).toBe(workspaceId);
      expect(rows[0].role).toBe('reviewer');
    });

    it('marks the invitation accepted', async () => {
      const email = freshEmail();
      const workspaceId = await invite(email);
      await auth.api.signUpEmail({
        body: { email, password: 'correct-horse-battery', name: 'Invited' },
      });
      const [row] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.workspaceId, workspaceId));
      expect(row.status).toBe('accepted');
    });

    it('an invited person can accept by signing in with Google — no action involved', async () => {
      // The sign-up server action is email-only, so an invite could never be
      // accepted through a social callback before this lived in the hook.
      const email = freshEmail();
      const workspaceId = await invite(email, 'operator');
      const ctx = await auth.$context;
      await ctx.internalAdapter.createUser({ email, name: 'Google Invitee', emailVerified: true });

      const rows = await membershipsFor(email);
      expect(rows).toHaveLength(1);
      expect(rows[0].workspaceId).toBe(workspaceId);
      expect(rows[0].role).toBe('operator');
    });

    it('joins every pending invitation, not just the first', async () => {
      const email = freshEmail();
      const a = await invite(email, 'reviewer');
      const b = await invite(email, 'operator');
      await auth.api.signUpEmail({
        body: { email, password: 'correct-horse-battery', name: 'Popular' },
      });
      const rows = await membershipsFor(email);
      expect(rows.map((r) => r.workspaceId).sort()).toEqual([a, b].sort());
    });

    it('an accepted invitation is not re-joined on a repeated call', async () => {
      const email = freshEmail();
      await invite(email);
      await auth.api.signUpEmail({
        body: { email, password: 'correct-horse-battery', name: 'Invited' },
      });
      const u = await db.query.user.findFirst({ where: eq(userTable.email, email) });
      await assignWorkspaceOnSignup(u!.id, email);
      expect(await membershipsFor(email)).toHaveLength(1);
    });
  });
});
