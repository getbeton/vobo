import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { ensureMigrated, truncateAll, db } from './harness';
import { auth } from '@/lib/auth/auth';
import { reconcileOnGoogleLink } from '@/lib/auth/linking';
import { normalizeEmail } from '@/lib/auth/bootstrap';
import { user as userTable, account as accountTable, workspaceMembers } from '@/lib/db/schema';

/**
 * VOBO-168 — Google identities meeting earlier email/password signups.
 * The load-bearing case is the unverified one: anyone can register an
 * email/password account for an address they do not own, so linking Google
 * into it would hand the squatter the real owner's account.
 */

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
});

const freshEmail = () => `link-${randomBytes(4).toString('hex')}@test.local`;

async function signUpEmail(email: string) {
  await auth.api.signUpEmail({
    body: { email, password: 'correct-horse-battery', name: 'Prior' },
  });
  return db.query.user.findFirst({ where: eq(userTable.email, normalizeEmail(email)) });
}

/**
 * The shape BetterAuth writes when a Google identity attaches to a user.
 * Creating the account row is enough — the account.create hook runs the
 * reconciliation, which is exactly the path a real callback takes.
 */
async function attachGoogle(userId: string) {
  const ctx = await auth.$context;
  await ctx.internalAdapter.createAccount({
    userId,
    providerId: 'google',
    accountId: `google-${randomBytes(4).toString('hex')}`,
    scope: 'email profile openid',
  });
}

async function credentialFor(userId: string) {
  return db.query.account.findFirst({
    where: and(eq(accountTable.userId, userId), eq(accountTable.providerId, 'credential')),
  });
}

describe('email normalisation', () => {
  it('stores one canonical form regardless of the case typed', async () => {
    const email = freshEmail();
    const upper = email.toUpperCase();
    const created = await signUpEmail(upper);
    expect(created!.email).toBe(email.toLowerCase());
  });

  it('treats a different case as the SAME account, not a second one', async () => {
    const email = freshEmail();
    await signUpEmail(email);
    await expect(
      auth.api.signUpEmail({
        body: { email: email.toUpperCase(), password: 'correct-horse-battery', name: 'Dup' },
      })
    ).rejects.toThrow();
    const all = await db.select().from(userTable);
    expect(all).toHaveLength(1);
  });

  it('does NOT collapse dots or +tags — those are one provider’s convention', async () => {
    // Deliberate: other providers treat these as distinct people.
    expect(normalizeEmail('A.User+tag@Example.com')).toBe('a.user+tag@example.com');
  });
});

describe('linking Google to an existing account', () => {
  it('keeps ONE user and ONE workspace — no second identity', async () => {
    const email = freshEmail();
    const prior = await signUpEmail(email);
    const priorMemberships = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, prior!.id));

    await attachGoogle(prior!.id);

    expect(await db.select().from(userTable)).toHaveLength(1);
    const after = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, prior!.id));
    expect(after).toHaveLength(priorMemberships.length);
    expect(after[0].workspaceId).toBe(priorMemberships[0].workspaceId);
    expect(after[0].role).toBe(priorMemberships[0].role);
  });

  it('revokes an UNVERIFIED password on link — the squatter loses it, the owner keeps the account', async () => {
    const email = freshEmail();
    const prior = await signUpEmail(email);
    expect(prior!.emailVerified).toBe(false);
    expect(await credentialFor(prior!.id)).toBeTruthy();

    await attachGoogle(prior!.id);
    expect(await credentialFor(prior!.id)).toBeFalsy();

    const refreshed = await db.query.user.findFirst({ where: eq(userTable.id, prior!.id) });
    expect(refreshed!.emailVerified).toBe(true);

    // And the planted password no longer opens the account.
    await expect(
      auth.api.signInEmail({ body: { email, password: 'correct-horse-battery' } })
    ).rejects.toThrow();
  });

  it('leaves a VERIFIED password alone — both credentials keep working', async () => {
    const email = freshEmail();
    const prior = await signUpEmail(email);
    await db
      .update(userTable)
      .set({ emailVerified: true })
      .where(eq(userTable.id, prior!.id));

    await attachGoogle(prior!.id);
    expect(await credentialFor(prior!.id)).toBeTruthy();

    const session = await auth.api.signInEmail({
      body: { email, password: 'correct-horse-battery' },
    });
    expect(session.user.id).toBe(prior!.id);
  });

  it('marks a Google-first account verified and leaves it password-less', async () => {
    const email = freshEmail();
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createUser({
      email,
      name: 'Google First',
      emailVerified: false,
    });

    await attachGoogle(created.id);
    expect(await credentialFor(created.id)).toBeFalsy();
    const refreshed = await db.query.user.findFirst({ where: eq(userTable.id, created.id) });
    expect(refreshed!.emailVerified).toBe(true);
  });

  it('is idempotent — replaying the link changes nothing further', async () => {
    const email = freshEmail();
    const prior = await signUpEmail(email);
    await attachGoogle(prior!.id);

    const replay = await reconcileOnGoogleLink(prior!.id);
    expect(replay).toEqual({ linked: true, revokedUnverifiedPassword: false });
    expect(await credentialFor(prior!.id)).toBeFalsy();
    expect(await db.select().from(userTable)).toHaveLength(1);
  });
});
