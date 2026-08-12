import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

// Capture what would have been emailed. Hoisted, so lib/auth/auth.ts picks up
// the mock when it imports the sender.
const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>();
  return {
    ...actual,
    sendMail: async (mail: { to: string; subject: string; text: string }) => {
      sent.push(mail);
      return { delivered: true };
    },
  };
});

import { ensureMigrated, truncateAll, db } from './harness';
import { auth } from '@/lib/auth/auth';
import { user as userTable, account as accountTable, workspaceMembers } from '@/lib/db/schema';

/**
 * Email verification and magic link. The point of both: an address holds an
 * account only once someone has proven they can read that mailbox.
 */

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});

const freshEmail = () => `mail-${randomBytes(4).toString('hex')}@test.local`;
const tokenFrom = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('token')!;

describe('email/password now requires a proven address', () => {
  it('refuses sign-in until the address is verified', async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Unverified' },
    });

    await expect(
      auth.api.signInEmail({ body: { email, password: 'correct-horse-battery' } })
    ).rejects.toThrow();

    const created = await db.query.user.findFirst({ where: eq(userTable.email, email) });
    expect(created!.emailVerified).toBe(false);
  });

  it('emails a verification link on signup', async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Unverified' },
    });
    const mail = sent.find((m) => m.to === email);
    expect(mail, 'a verification email').toBeTruthy();
    expect(mail!.subject).toMatch(/confirm/i);
    expect(mail!.text).toMatch(/https?:\/\//);
  });

  it('lets the same credentials through once verified', async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Later Verified' },
    });
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.email, email));

    const session = await auth.api.signInEmail({
      body: { email, password: 'correct-horse-battery' },
    });
    expect(session.user.email).toBe(email);
  });

  it('still assigns a workspace even though sign-in is blocked', async () => {
    // The account exists and is waiting on the mailbox — it must not be
    // half-built when the person finally clicks through.
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Pending' },
    });
    const created = await db.query.user.findFirst({ where: eq(userTable.email, email) });
    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, created!.id));
    expect(rows).toHaveLength(1);
  });
});

describe('magic link', () => {
  it('creates nothing until the link is opened', async () => {
    const email = freshEmail();
    await auth.api.signInMagicLink({ body: { email, callbackURL: '/welcome' }, headers: new Headers() });

    expect(sent.at(-1)!.to).toBe(email);
    expect(sent.at(-1)!.subject).toMatch(/sign-in link/i);
    // Nothing squats on the address in the meantime.
    expect(await db.query.user.findFirst({ where: eq(userTable.email, email) })).toBeFalsy();
  });

  it('opening the link yields a verified user, a workspace, and no password', async () => {
    const email = freshEmail();
    await auth.api.signInMagicLink({ body: { email, callbackURL: '/welcome' }, headers: new Headers() });
    await auth.api.magicLinkVerify({ query: { token: tokenFrom(sent.at(-1)!.text) }, headers: new Headers() });

    const created = await db.query.user.findFirst({ where: eq(userTable.email, email) });
    expect(created, 'user after opening the link').toBeTruthy();
    expect(created!.emailVerified).toBe(true);

    const credential = await db.query.account.findFirst({
      where: eq(accountTable.userId, created!.id),
    });
    expect(credential?.password ?? null).toBeNull();

    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, created!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
  });

  it('a token cannot be replayed', async () => {
    const email = freshEmail();
    await auth.api.signInMagicLink({ body: { email, callbackURL: '/welcome' }, headers: new Headers() });
    const token = tokenFrom(sent.at(-1)!.text);

    await auth.api.magicLinkVerify({ query: { token }, headers: new Headers() });
    await expect(
      auth.api.magicLinkVerify({ query: { token }, headers: new Headers() })
    ).rejects.toThrow();
  });

  it('signs an existing account in rather than duplicating it', async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: 'correct-horse-battery', name: 'Existing' },
    });
    const before = await db.query.user.findFirst({ where: eq(userTable.email, email) });

    await auth.api.signInMagicLink({ body: { email, callbackURL: '/welcome' }, headers: new Headers() });
    await auth.api.magicLinkVerify({ query: { token: tokenFrom(sent.at(-1)!.text) }, headers: new Headers() });

    const after = await db.select().from(userTable).where(eq(userTable.email, email));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before!.id);
    // And the mailbox proof clears the verification gate for the password too.
    expect(after[0].emailVerified).toBe(true);
  });
});
