'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import {
  workspaces,
  workspaceMembers,
  invitations,
  projects,
  queues,
} from '@/lib/db/schema';
import { ApiProblem } from '@/lib/core/requests';
import { can, Role, workspaceOfQueue } from '@/lib/core/authz';
import { workspaceDefaultsSchema, policyConfigSchema } from '@/lib/core/policy';
import { publishQueuePolicy } from '@/lib/core/policy-store';
import { ActionResult } from './review';

/**
 * Workspace / project / queue administration (prototype: Workspace page,
 * Project page, Queue page). Policy edits never mutate history — they change
 * the inputs and publish a NEW immutable policy version.
 */

function wrap<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  return async (...args: A): Promise<ActionResult<T>> => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (err instanceof ApiProblem) return { ok: false, error: err.message, code: err.code };
      console.error('admin action error:', err);
      return { ok: false, error: 'Something went wrong', code: 'internal' };
    }
  };
}

async function currentUser() {
  const user = await getUser();
  if (!user) throw new ApiProblem(401, 'unauthenticated', 'Sign in required');
  return user;
}

/** Republish every queue under a workspace after its defaults moved. */
async function republishWorkspaceQueues(workspaceId: number, userId: string) {
  const rows = await db
    .select({ id: queues.id })
    .from(queues)
    .innerJoin(projects, eq(projects.id, queues.projectId))
    .where(eq(projects.workspaceId, workspaceId));
  for (const q of rows) await publishQueuePolicy(db, q.id, userId);
  return rows.length;
}

export const setWorkspaceDefaultsAction = wrap(
  async (workspaceId: number, patch: Record<string, unknown>) => {
    const user = await currentUser();
    await can.operate(user.id, workspaceId);
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) throw new ApiProblem(404, 'workspace_not_found', 'Workspace not found');

    const merged = workspaceDefaultsSchema.parse({
      ...(ws.policyDefaults as object),
      ...patch,
    });
    await db
      .update(workspaces)
      .set({ policyDefaults: merged, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));

    const republished = await republishWorkspaceQueues(workspaceId, user.id);
    revalidatePath('/admin');
    return { republished };
  }
);

/**
 * Set or clear per-queue overrides. A `null` value clears the key, dropping
 * that setting back to inheriting the workspace default.
 */
export const setQueueOverrideAction = wrap(
  async (queueId: string, patch: Record<string, unknown>) => {
    const user = await currentUser();
    const wsId = await workspaceOfQueue(queueId);
    await can.operate(user.id, wsId);

    const queue = await db.query.queues.findFirst({ where: eq(queues.id, queueId) });
    if (!queue) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');

    const next: Record<string, unknown> = { ...(queue.policyOverrides as object) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    // Validate the override subset before it can reach a policy version.
    policyConfigSchema.partial().parse(next);

    await db.update(queues).set({ policyOverrides: next }).where(eq(queues.id, queueId));
    const published = await publishQueuePolicy(db, queueId, user.id);
    revalidatePath(`/admin/queues/${queue.slug}`);
    return published;
  }
);

/**
 * Apply an override to every environment row of a queue slug. A "queue" is one
 * user-facing thing with a production and a test instance; the prototype's
 * queue page edits both at once ("applies to new rounds in both environments").
 */
export const setQueueSlugOverrideAction = wrap(
  async (projectId: string, slug: string, patch: Record<string, unknown>) => {
    const user = await currentUser();
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
    await can.operate(user.id, project.workspaceId);

    const rows = await db
      .select({ id: queues.id, overrides: queues.policyOverrides })
      .from(queues)
      .where(and(eq(queues.projectId, projectId), eq(queues.slug, slug)));
    if (rows.length === 0) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');

    for (const row of rows) {
      const next: Record<string, unknown> = { ...(row.overrides as object) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      policyConfigSchema.partial().parse(next);
      await db.update(queues).set({ policyOverrides: next }).where(eq(queues.id, row.id));
      await publishQueuePolicy(db, row.id, user.id);
    }
    revalidatePath(`/admin/queues/${slug}`);
    return { environments: rows.length };
  }
);

export const setMemberRoleAction = wrap(async (memberId: number, role: Role) => {
  const user = await currentUser();
  const member = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.id, memberId),
  });
  if (!member) throw new ApiProblem(404, 'member_not_found', 'Member not found');
  await can.administer(user.id, member.workspaceId);

  // Never let the last admin demote themselves out of the workspace.
  if (member.role === 'admin' && role !== 'admin') {
    const admins = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, member.workspaceId),
          eq(workspaceMembers.role, 'admin')
        )
      );
    if (admins.length <= 1) {
      throw new ApiProblem(409, 'last_admin', 'A workspace needs at least one admin');
    }
  }

  await db.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, memberId));
  revalidatePath('/admin');
});

export const removeMemberAction = wrap(async (memberId: number) => {
  const user = await currentUser();
  const member = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.id, memberId),
  });
  if (!member) throw new ApiProblem(404, 'member_not_found', 'Member not found');
  await can.administer(user.id, member.workspaceId);
  if (member.userId === user.id) {
    throw new ApiProblem(409, 'self_removal', 'You cannot remove yourself');
  }
  await db.delete(workspaceMembers).where(eq(workspaceMembers.id, memberId));
  revalidatePath('/admin');
});

export const inviteMemberAction = wrap(
  async (workspaceId: number, email: string, role: Role = 'reviewer') => {
    const user = await currentUser();
    await can.administer(user.id, workspaceId);
    const clean = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      throw new ApiProblem(400, 'invalid_email', 'Enter a valid email address');
    }
    await db.insert(invitations).values({
      workspaceId,
      email: clean,
      role,
      invitedBy: user.id,
    });
    revalidatePath('/admin');
    return { email: clean };
  }
);
