'use server';

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { APIError } from 'better-auth';
import { db } from '@/lib/db/drizzle';
import {
  workspaces,
  workspaceMembers,
  activityLogs,
  ActivityType,
  invitations,
  user as userTable,
} from '@/lib/db/schema';
import { auth } from '@/lib/auth/auth';
import { normalizeEmail } from '@/lib/auth/bootstrap';
import { redirect } from 'next/navigation';
import { getUser, getUserWithWorkspace } from '@/lib/db/queries';
import {
  validatedAction,
  validatedActionWithUser,
} from '@/lib/auth/middleware';

async function logActivity(
  workspaceId: number | null | undefined,
  userId: string,
  type: ActivityType,
  ipAddress?: string
) {
  if (workspaceId === null || workspaceId === undefined) {
    return;
  }
  await db.insert(activityLogs).values({
    workspaceId,
    userId,
    action: type,
    ipAddress: ipAddress || '',
  });
}

/**
 * Surface what BetterAuth actually said. Swallowing every APIError into
 * "please try again" told a user whose email already existed to retry
 * something that could never succeed. Keep a generic fallback for the cases
 * where there is no safe message to show.
 */
function authErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof APIError) {
    const body = error.body as { message?: string; code?: string } | undefined;
    const message = body?.message ?? error.message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return fallback;
}

const signInSchema = z.object({
  email: z.string().email().min(3).max(255).transform(normalizeEmail),
  password: z.string().min(8).max(100),
});

export const signIn = validatedAction(signInSchema, async (data) => {
  const { email, password } = data;

  try {
    await auth.api.signInEmail({
      body: { email, password },
      headers: await headers(),
    });
  } catch (error) {
    if (error instanceof APIError) {
      return {
        error: authErrorMessage(error, 'Invalid email or password. Please try again.'),
        email,
        password,
      };
    }
    throw error;
  }

  const [row] = await db
    .select({ userId: userTable.id, workspaceId: workspaceMembers.workspaceId })
    .from(userTable)
    .leftJoin(workspaceMembers, eq(userTable.id, workspaceMembers.userId))
    .where(eq(userTable.email, email))
    .limit(1);
  if (row) {
    await logActivity(row.workspaceId, row.userId, ActivityType.SIGN_IN);
  }

  redirect('/dashboard');
});

const signUpSchema = z.object({
  email: z.string().email().transform(normalizeEmail),
  password: z.string().min(8),
  inviteId: z.string().optional(),
});

export const signUp = validatedAction(signUpSchema, async (data) => {
  const { email, password, inviteId } = data;

  if (inviteId) {
    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, parseInt(inviteId)),
          eq(invitations.email, normalizeEmail(email)),
          eq(invitations.status, 'pending')
        )
      )
      .limit(1);
    if (!invitation) {
      return { error: 'Invalid or expired invitation.', email, password };
    }
  }

  let createdUserId: string;
  try {
    const res = await auth.api.signUpEmail({
      body: { email, password, name: email.split('@')[0] },
      headers: await headers(),
    });
    createdUserId = res.user.id;
  } catch (error) {
    if (error instanceof APIError) {
      return {
        error: authErrorMessage(error, 'Could not create the account. Please try again.'),
        email,
        password,
      };
    }
    throw error;
  }

  // Workspace assignment already happened in the user-create hook, which is
  // invitation-aware and runs for every signup path. All that is left here is
  // reporting: which workspace did this person actually land in?
  const membership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, createdUserId),
  });
  const workspaceId = membership!.workspaceId;

  await logActivity(workspaceId, createdUserId, ActivityType.SIGN_UP);

  redirect('/dashboard');
});

export async function signOut() {
  const user = await getUser();
  if (user) {
    const withWs = await getUserWithWorkspace(user.id);
    await logActivity(withWs?.workspaceId, user.id, ActivityType.SIGN_OUT);
  }
  await auth.api.signOut({ headers: await headers() });
}

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(100),
  newPassword: z.string().min(8).max(100),
  confirmPassword: z.string().min(8).max(100),
});

export const updatePassword = validatedActionWithUser(
  updatePasswordSchema,
  async (data, _, user) => {
    const { currentPassword, newPassword, confirmPassword } = data;

    if (currentPassword === newPassword) {
      return {
        currentPassword,
        newPassword,
        confirmPassword,
        error: 'New password must be different from the current password.',
      };
    }

    if (confirmPassword !== newPassword) {
      return {
        currentPassword,
        newPassword,
        confirmPassword,
        error: 'New password and confirmation password do not match.',
      };
    }

    try {
      await auth.api.changePassword({
        body: { currentPassword, newPassword },
        headers: await headers(),
      });
    } catch (error) {
      if (error instanceof APIError) {
        return {
          currentPassword,
          newPassword,
          confirmPassword,
          error: 'Current password is incorrect.',
        };
      }
      throw error;
    }

    const withWs = await getUserWithWorkspace(user.id);
    await logActivity(withWs?.workspaceId, user.id, ActivityType.UPDATE_PASSWORD);

    return { success: 'Password updated successfully.' };
  }
);

const deleteAccountSchema = z.object({
  password: z.string().min(8).max(100),
});

export const deleteAccount = validatedActionWithUser(
  deleteAccountSchema,
  async (data, _, user) => {
    const { password } = data;

    const withWs = await getUserWithWorkspace(user.id);
    await logActivity(withWs?.workspaceId, user.id, ActivityType.DELETE_ACCOUNT);

    if (withWs?.workspaceId) {
      await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, user.id),
            eq(workspaceMembers.workspaceId, withWs.workspaceId)
          )
        );
    }

    try {
      await auth.api.deleteUser({
        body: { password },
        headers: await headers(),
      });
    } catch (error) {
      if (error instanceof APIError) {
        return { password, error: 'Incorrect password. Account deletion failed.' };
      }
      throw error;
    }

    redirect('/sign-in');
  }
);

const updateAccountSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
});

export const updateAccount = validatedActionWithUser(
  updateAccountSchema,
  async (data, _, user) => {
    const { name, email } = data;

    if (email !== user.email) {
      return {
        name,
        error: 'Email change is not supported yet — contact an admin.',
      };
    }

    await auth.api.updateUser({
      body: { name },
      headers: await headers(),
    });

    const withWs = await getUserWithWorkspace(user.id);
    await logActivity(withWs?.workspaceId, user.id, ActivityType.UPDATE_ACCOUNT);

    return { name, success: 'Account updated successfully.' };
  }
);

const removeMemberSchema = z.object({
  memberId: z.number(),
});

export const removeWorkspaceMember = validatedActionWithUser(
  removeMemberSchema,
  async (data, _, user) => {
    const { memberId } = data;
    const withWs = await getUserWithWorkspace(user.id);

    if (!withWs?.workspaceId) {
      return { error: 'User is not part of a workspace' };
    }

    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.id, memberId),
          eq(workspaceMembers.workspaceId, withWs.workspaceId)
        )
      );

    await logActivity(withWs.workspaceId, user.id, ActivityType.REMOVE_WORKSPACE_MEMBER);

    return { success: 'Workspace member removed successfully' };
  }
);

const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum(['admin', 'operator', 'reviewer']),
});

export const inviteWorkspaceMember = validatedActionWithUser(
  inviteMemberSchema,
  async (data, _, user) => {
    const { email, role } = data;
    const withWs = await getUserWithWorkspace(user.id);

    if (!withWs?.workspaceId) {
      return { error: 'User is not part of a workspace' };
    }

    const existingMember = await db
      .select()
      .from(userTable)
      .leftJoin(workspaceMembers, eq(userTable.id, workspaceMembers.userId))
      .where(
        and(eq(userTable.email, email), eq(workspaceMembers.workspaceId, withWs.workspaceId))
      )
      .limit(1);

    if (existingMember.length > 0) {
      return { error: 'User is already a member of this workspace' };
    }

    const existingInvitation = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.email, email),
          eq(invitations.workspaceId, withWs.workspaceId),
          eq(invitations.status, 'pending')
        )
      )
      .limit(1);

    if (existingInvitation.length > 0) {
      return { error: 'An invitation has already been sent to this email' };
    }

    await db.insert(invitations).values({
      workspaceId: withWs.workspaceId,
      email,
      role,
      invitedBy: user.id,
      status: 'pending',
    });

    await logActivity(withWs.workspaceId, user.id, ActivityType.INVITE_WORKSPACE_MEMBER);

    // TODO: Send invitation email with ?inviteId={id} on the sign-up URL
    return { success: 'Invitation sent successfully' };
  }
);
