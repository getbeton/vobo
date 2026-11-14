import { asc, desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from './drizzle';
import { activityLogs, workspaceMembers, user as userTable } from './schema';
import { auth } from '@/lib/auth/auth';

export async function getUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

export async function getUserWithWorkspace(userId: string) {
  const result = await db
    .select({
      user: userTable,
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(userTable)
    .leftJoin(workspaceMembers, eq(userTable.id, workspaceMembers.userId))
    .where(eq(userTable.id, userId))
    .limit(1);

  return result[0];
}

export async function getActivityLogs() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      timestamp: activityLogs.timestamp,
      ipAddress: activityLogs.ipAddress,
      userName: userTable.name,
    })
    .from(activityLogs)
    .leftJoin(userTable, eq(activityLogs.userId, userTable.id))
    .where(eq(activityLogs.userId, user.id))
    .orderBy(desc(activityLogs.timestamp))
    .limit(10);
}

export async function getWorkspaceForUser() {
  const user = await getUser();
  if (!user) {
    return null;
  }

  const result = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, user.id),
    with: {
      workspace: {
        columns: {
          id: true,
          name: true,
          slug: true,
          policyDefaults: true,
          plan: true,
          createdAt: true,
          updatedAt: true,
        },
        with: {
          members: {
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return result?.workspace || null;
}

export async function getMembership(userId: string) {
  return db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, userId),
  });
}

/**
 * The workspace a page should show for this user. `findFirst` with no ordering
 * returns whichever row Postgres feels like, so someone in two workspaces could
 * land in a different one on every request. Oldest membership wins: the
 * workspace you were in first is the one you think of as yours.
 *
 * This is a stopgap for the real answer, a workspace switcher in the shell
 * (the prototype has the control; it is wired to a single option today).
 */
export async function currentMembership(userId: string) {
  const [row] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id))
    .limit(1);
  return row ?? null;
}
