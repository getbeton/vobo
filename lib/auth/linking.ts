import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { user as userTable, account as accountTable, activityLogs, ActivityType } from '@/lib/db/schema';

/**
 * Identity reconciliation between Google and earlier email/password signups
 * (VOBO-168).
 *
 * Linking by email is the whole point — the same human should not end up as two
 * users — but it carries one specific attack. Registering an email/password
 * account for an address you do not own is now blocked at the front door
 * (`requireEmailVerification`, plus magic link as the preferred email path), so
 * this is defence in depth for the accounts that predate that: rows created
 * before verification was switched on are still sitting there unverified. If
 * the real owner signs in with Google and we link the identities, the
 * squatter's password would open the owner's account.
 *
 * Google has actually verified the address; the local password never was. So on
 * linking Google into an account whose email is unverified, the unproven
 * credential is revoked and the address is marked verified. The rightful owner
 * keeps the account and can set a password again; the squatter loses the one
 * they planted. Refusing to link instead would hand the squatter a permanent
 * denial-of-service over that address.
 *
 * When the email WAS verified, the password stands — both credentials work.
 */

export interface LinkOutcome {
  linked: boolean;
  revokedUnverifiedPassword: boolean;
}

export async function reconcileOnGoogleLink(userId: string): Promise<LinkOutcome> {
  const account = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
  if (!account) return { linked: false, revokedUnverifiedPassword: false };

  const credential = await db.query.account.findFirst({
    where: and(eq(accountTable.userId, userId), eq(accountTable.providerId, 'credential')),
  });

  // Nothing to protect: no local password on this account.
  if (!credential?.password) {
    if (!account.emailVerified) {
      await db
        .update(userTable)
        .set({ emailVerified: true, updatedAt: new Date() })
        .where(eq(userTable.id, userId));
    }
    return { linked: true, revokedUnverifiedPassword: false };
  }

  if (account.emailVerified) {
    return { linked: true, revokedUnverifiedPassword: false };
  }

  // Unverified local password + a Google identity Google itself verified.
  await db
    .delete(accountTable)
    .where(and(eq(accountTable.userId, userId), eq(accountTable.providerId, 'credential')));
  await db
    .update(userTable)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(userTable.id, userId));

  const membership = await db.query.workspaceMembers.findFirst({
    where: (m, { eq: e }) => e(m.userId, userId),
  });
  if (membership) {
    await db.insert(activityLogs).values({
      workspaceId: membership.workspaceId,
      userId,
      action: ActivityType.UPDATE_PASSWORD,
      ipAddress: '',
    });
  }

  console.warn(
    `[auth] revoked an unverified password credential for user ${userId} on Google link ` +
      '(the address was never proven by the password holder; Google proved it)'
  );
  return { linked: true, revokedUnverifiedPassword: true };
}
