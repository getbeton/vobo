import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  workspaces,
  workspaceMembers,
  invitations,
  activityLogs,
  ActivityType,
} from '@/lib/db/schema';

/**
 * Workspace assignment at signup.
 *
 * Two rules, and they have to hold together:
 *   1. No signup may end without a workspace — a user with none bounces off
 *      every workspace-scoped page.
 *   2. An invited user joins the workspace they were invited to, and does not
 *      collect a stray personal workspace beside it.
 *
 * Both live here rather than in any one sign-up flow, because social sign-in
 * never touches the sign-up server action and its callback may redirect
 * anywhere. Invitations are keyed by email, which is the only thing the
 * user-create hook knows — so acceptance happens here too, and an invited
 * person can accept by signing in with Google, which the action-only flow
 * could never support.
 */

/** Normalised form used for every email comparison. See VOBO-168. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Accept every pending invitation for this address. Returns joined workspaces. */
export async function acceptPendingInvitations(
  userId: string,
  email: string
): Promise<number[]> {
  const address = normalizeEmail(email);
  const pending = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, address), eq(invitations.status, 'pending')));

  const joined: number[] = [];
  for (const invitation of pending) {
    const already = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, invitation.workspaceId)
      ),
    });
    if (!already) {
      await db.insert(workspaceMembers).values({
        userId,
        workspaceId: invitation.workspaceId,
        role: invitation.role,
      });
    }
    await db
      .update(invitations)
      .set({ status: 'accepted' })
      .where(eq(invitations.id, invitation.id));
    await db.insert(activityLogs).values({
      workspaceId: invitation.workspaceId,
      userId,
      action: ActivityType.ACCEPT_INVITATION,
      ipAddress: '',
    });
    joined.push(invitation.workspaceId);
  }
  return joined;
}

/**
 * Idempotent: a user who already has any membership keeps it, so a repeated
 * OAuth callback cannot mint a second workspace.
 */
export async function ensurePersonalWorkspace(
  userId: string,
  email: string
): Promise<number> {
  const existing = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, userId),
  });
  if (existing) return existing.workspaceId;

  const local = normalizeEmail(email).split('@')[0];
  const name = `${local}'s workspace`;
  const [workspace] = await db
    .insert(workspaces)
    .values({ name, slug: slugify(name) })
    .returning();

  await db.insert(workspaceMembers).values({
    userId,
    workspaceId: workspace.id,
    role: 'admin',
  });
  await db.insert(activityLogs).values({
    workspaceId: workspace.id,
    userId,
    action: ActivityType.CREATE_WORKSPACE,
    ipAddress: '',
  });

  return workspace.id;
}

/**
 * The one call the user-create hook makes. Invitation first; a personal
 * workspace only when there was nothing to join — so rule 2 never costs us
 * rule 1.
 */
export async function assignWorkspaceOnSignup(
  userId: string,
  email: string
): Promise<{ workspaceIds: number[]; viaInvitation: boolean }> {
  const invited = await acceptPendingInvitations(userId, email);
  if (invited.length > 0) return { workspaceIds: invited, viaInvitation: true };
  return { workspaceIds: [await ensurePersonalWorkspace(userId, email)], viaInvitation: false };
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : suffix;
}
