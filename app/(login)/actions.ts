'use server';

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import {
  User,
  users,
  workspaces,
  workspaceMembers,
  activityLogs,
  type NewUser,
  ActivityType,
  invitations,
} from '@/lib/db/schema';
import { comparePasswords, hashPassword, setSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getUser, getUserWithWorkspace } from '@/lib/db/queries';
import {
  validatedAction,
  validatedActionWithUser,
} from '@/lib/auth/middleware';

async function logActivity(
  workspaceId: number | null | undefined,
  userId: number,
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

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : suffix;
}

const signInSchema = z.object({
  email: z.string().email().min(3).max(255),
  password: z.string().min(8).max(100),
});

export const signIn = validatedAction(signInSchema, async (data) => {
  const { email, password } = data;

  const rows = await db
    .select({ user: users, workspace: workspaces })
    .from(users)
    .leftJoin(workspaceMembers, eq(users.id, workspaceMembers.userId))
    .leftJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(users.email, email))
    .limit(1);

  if (rows.length === 0) {
    return { error: 'Invalid email or password. Please try again.', email, password };
  }

  const { user: foundUser, workspace: foundWorkspace } = rows[0];

  const isPasswordValid = await comparePasswords(password, foundUser.passwordHash);
  if (!isPasswordValid) {
    return { error: 'Invalid email or password. Please try again.', email, password };
  }

  await Promise.all([
    setSession(foundUser),
    logActivity(foundWorkspace?.id, foundUser.id, ActivityType.SIGN_IN),
  ]);

  redirect('/dashboard');
});

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  inviteId: z.string().optional(),
});

export const signUp = validatedAction(signUpSchema, async (data) => {
  const { email, password, inviteId } = data;

  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existingUser.length > 0) {
    return { error: 'Failed to create user. Please try again.', email, password };
  }

  const passwordHash = await hashPassword(password);

  const newUser: NewUser = { email, passwordHash };
  const [createdUser] = await db.insert(users).values(newUser).returning();

  if (!createdUser) {
    return { error: 'Failed to create user. Please try again.', email, password };
  }

  let workspaceId: number;
  let userRole: 'admin' | 'operator' | 'reviewer' | 'adjudicator' = 'admin';

  if (inviteId) {
    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.id, parseInt(inviteId)),
          eq(invitations.email, email),
          eq(invitations.status, 'pending')
        )
      )
      .limit(1);

    if (!invitation) {
      return { error: 'Invalid or expired invitation.', email, password };
    }

    workspaceId = invitation.workspaceId;
    userRole = invitation.role;

    await db
      .update(invitations)
      .set({ status: 'accepted' })
      .where(eq(invitations.id, invitation.id));

    await logActivity(workspaceId, createdUser.id, ActivityType.ACCEPT_INVITATION);
  } else {
    const name = `${email.split('@')[0]}'s workspace`;
    const [createdWorkspace] = await db
      .insert(workspaces)
      .values({ name, slug: slugify(name) })
      .returning();

    if (!createdWorkspace) {
      return { error: 'Failed to create workspace. Please try again.', email, password };
    }

    workspaceId = createdWorkspace.id;
    userRole = 'admin';
    await logActivity(workspaceId, createdUser.id, ActivityType.CREATE_WORKSPACE);
  }

  await Promise.all([
    db.insert(workspaceMembers).values({
      userId: createdUser.id,
      workspaceId,
      role: userRole,
    }),
    logActivity(workspaceId, createdUser.id, ActivityType.SIGN_UP),
    setSession(createdUser),
  ]);

  redirect('/dashboard');
});

export async function signOut() {
  const user = (await getUser()) as User;
  const withWs = await getUserWithWorkspace(user.id);
  await logActivity(withWs?.workspaceId, user.id, ActivityType.SIGN_OUT);
  (await cookies()).delete('session');
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

    const isPasswordValid = await comparePasswords(currentPassword, user.passwordHash);
    if (!isPasswordValid) {
      return {
        currentPassword,
        newPassword,
        confirmPassword,
        error: 'Current password is incorrect.',
      };
    }

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

    const newPasswordHash = await hashPassword(newPassword);
    const withWs = await getUserWithWorkspace(user.id);

    await Promise.all([
      db.update(users).set({ passwordHash: newPasswordHash }).where(eq(users.id, user.id)),
      logActivity(withWs?.workspaceId, user.id, ActivityType.UPDATE_PASSWORD),
    ]);

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

    const isPasswordValid = await comparePasswords(password, user.passwordHash);
    if (!isPasswordValid) {
      return { password, error: 'Incorrect password. Account deletion failed.' };
    }

    const withWs = await getUserWithWorkspace(user.id);
    await logActivity(withWs?.workspaceId, user.id, ActivityType.DELETE_ACCOUNT);

    // Soft delete
    await db
      .update(users)
      .set({
        deletedAt: sql`CURRENT_TIMESTAMP`,
        email: sql`CONCAT(email, '-', id, '-deleted')`, // Ensure email uniqueness
      })
      .where(eq(users.id, user.id));

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

    (await cookies()).delete('session');
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
    const withWs = await getUserWithWorkspace(user.id);

    await Promise.all([
      db.update(users).set({ name, email }).where(eq(users.id, user.id)),
      logActivity(withWs?.workspaceId, user.id, ActivityType.UPDATE_ACCOUNT),
    ]);

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
      .from(users)
      .leftJoin(workspaceMembers, eq(users.id, workspaceMembers.userId))
      .where(
        and(eq(users.email, email), eq(workspaceMembers.workspaceId, withWs.workspaceId))
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
