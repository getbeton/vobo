import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { workspaces, workspaceMembers, activityLogs, ActivityType } from '@/lib/db/schema';

/**
 * Every signed-in user must belong to a workspace — every protected page
 * resolves membership first and bounces to /sign-in without one. The email
 * flow could do this inline in its server action, but social sign-in never
 * touches that action, so the rule lives here and both paths call it.
 *
 * Idempotent by construction: a user who already has a membership keeps it, so
 * a repeated OAuth callback cannot mint a second workspace.
 */
export async function ensurePersonalWorkspace(
  userId: string,
  email: string
): Promise<number> {
  const existing = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, userId),
  });
  if (existing) return existing.workspaceId;

  const local = email.split('@')[0];
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

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : suffix;
}
