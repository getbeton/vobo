import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { workspaceMembers, projects, queues, reviewRequests } from '@/lib/db/schema';
import { ApiProblem } from './requests';

/**
 * Policy-closure authorization (Argilla pattern, ARD §12): one small
 * is-allowed check per resource/action, workspace-scoped by construction.
 * App-layer enforcement is the tenancy boundary (decision 4A).
 */

export type Role = 'admin' | 'operator' | 'reviewer' | 'adjudicator';

export async function membershipFor(userId: string, workspaceId: number) {
  return db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.workspaceId, workspaceId)
    ),
  });
}

export async function requireRole(
  userId: string,
  workspaceId: number,
  roles: Role[]
): Promise<Role> {
  const m = await membershipFor(userId, workspaceId);
  if (!m) throw new ApiProblem(403, 'not_a_member', 'Not a member of this workspace');
  // admin can do anything an operator/reviewer can.
  if (m.role === 'admin' || roles.includes(m.role)) return m.role;
  throw new ApiProblem(403, 'forbidden', `Requires role: ${roles.join(' or ')}`);
}

/** Resolve a request's workspace for scoping UI actions. */
export async function workspaceOfRequest(requestId: string): Promise<number> {
  const [row] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(reviewRequests)
    .innerJoin(projects, eq(projects.id, reviewRequests.projectId))
    .where(eq(reviewRequests.id, requestId))
    .limit(1);
  if (!row) throw new ApiProblem(404, 'request_not_found', 'Request not found');
  return row.workspaceId;
}

export async function workspaceOfQueue(queueId: string): Promise<number> {
  const [row] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(queues)
    .innerJoin(projects, eq(projects.id, queues.projectId))
    .where(eq(queues.id, queueId))
    .limit(1);
  if (!row) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');
  return row.workspaceId;
}

export const can = {
  /** Reviewers (and up) work the queue and judge artifacts. */
  review: (userId: string, workspaceId: number) =>
    requireRole(userId, workspaceId, ['reviewer', 'operator', 'adjudicator']),
  /** Operators (and up) rule on escalations and edit queue policy. */
  operate: (userId: string, workspaceId: number) =>
    requireRole(userId, workspaceId, ['operator']),
  /** Admins manage members and workspace settings. */
  administer: (userId: string, workspaceId: number) => requireRole(userId, workspaceId, []),
};

/**
 * Non-throwing variant for pages. An authorization refusal is an expected
 * outcome of a shared URL, not an exception — a page that lets ApiProblem
 * escape renders as "Application error: a server-side exception has occurred",
 * which tells the person nothing and looks like a fault in the product.
 */
export async function canReview(userId: string, workspaceId: number): Promise<boolean> {
  try {
    await can.review(userId, workspaceId);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a request's workspace without throwing when it does not exist. */
export async function workspaceOfRequestOrNull(requestId: string): Promise<number | null> {
  try {
    return await workspaceOfRequest(requestId);
  } catch {
    return null;
  }
}
