import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { reviewRequests, leases, queues, projects, policyVersions } from '@/lib/db/schema';
import { appendEvent, Db, DbOrTx } from './eventlog';
import { ApiProblem, getPolicyForRequest } from './requests';
import { parsePolicyConfig } from './policy';

/**
 * Queue ranking + atomic leases. Ranking rules are Policy-owned (reviewers
 * never configure sorting): sticky regenerations pin to the top for their
 * reviewer, then the policy's rule order (sla → priority → fifo in MVP).
 */

export type QueueEnvironment = 'production' | 'test';

export interface ResolveQueueInput {
  workspaceId: number;
  projectSlug?: string | null;
  queueSlug?: string | null;
  environment?: QueueEnvironment;
}

export interface ResolveQueueResult {
  /** The project the queue was found in, or null when nothing resolved. */
  project: typeof projects.$inferSelect | null;
  queue: typeof queues.$inferSelect | null;
  /** Every project in the workspace, deterministically ordered. */
  projects: Array<typeof projects.$inferSelect>;
  /** Distinct queue rows of the selected project, in the asked-for environment. */
  projectQueues: Array<typeof queues.$inferSelect>;
  /** Every queue slug in the workspace, for a truthful not-found message. */
  workspaceQueues: Array<{ projectSlug: string; projectName: string; queueSlug: string }>;
  /** True when the same slug exists in more than one project. */
  ambiguous: boolean;
  /** The projects that carry an ambiguous slug, in resolution order. */
  candidateProjects: Array<typeof projects.$inferSelect>;
  reason: 'project_not_found' | 'queue_not_found' | 'no_projects' | 'no_queues' | null;
}

/**
 * The single place that turns (workspace, project?, queue?, environment) into
 * one queue row.
 *
 * VOBO-204: the app shell, the queue page and the requests page each ran their
 * own `db.query.projects.findFirst({ where: eq(projects.workspaceId, …) })`.
 * That call has no `orderBy`, so which project won was whatever Postgres
 * returned, and a `?queue=` slug living in any other project resolved to
 * nothing — the page then claimed the pipeline had registered no queue. One
 * resolver, ordered by (createdAt, id), removes the copies and the ordering
 * hole together.
 *
 * Every query is scoped by workspace id, so no cross-tenant row is reachable
 * even with an exact slug. Archived projects and queues are omitted — they
 * stay in the table so slugs remain unique and create-review can name them.
 */
export async function resolveQueue(
  db: DbOrTx,
  input: ResolveQueueInput
): Promise<ResolveQueueResult> {
  const environment: QueueEnvironment = input.environment === 'test' ? 'test' : 'production';

  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, input.workspaceId), isNull(projects.archivedAt)))
    .orderBy(asc(projects.createdAt), asc(projects.id));

  const empty = {
    project: null,
    queue: null,
    projects: projectRows,
    projectQueues: [],
    workspaceQueues: [],
    ambiguous: false,
    candidateProjects: [],
  };

  if (projectRows.length === 0) {
    return { ...empty, reason: 'no_projects' as const };
  }

  const projectIds = projectRows.map((p) => p.id);
  const queueRows = await db
    .select()
    .from(queues)
    .where(
      and(
        inArray(queues.projectId, projectIds),
        eq(queues.environment, environment),
        isNull(queues.archivedAt)
      )
    )
    .orderBy(asc(queues.createdAt), asc(queues.id));

  const byId = new Map(projectRows.map((p) => [p.id, p]));
  const workspaceQueues = queueRows.map((q) => ({
    projectSlug: byId.get(q.projectId)!.slug,
    projectName: byId.get(q.projectId)!.name,
    queueSlug: q.slug,
  }));

  // An explicit project always wins. A project slug that does not exist is
  // reported, never silently swapped for the first project.
  if (input.projectSlug) {
    const project = projectRows.find((p) => p.slug === input.projectSlug);
    if (!project) {
      return { ...empty, workspaceQueues, reason: 'project_not_found' as const };
    }
    const projectQueues = queueRows.filter((q) => q.projectId === project.id);
    const queue = input.queueSlug
      ? projectQueues.find((q) => q.slug === input.queueSlug)
      : projectQueues[0];
    return {
      project,
      queue: queue ?? null,
      projects: projectRows,
      projectQueues,
      workspaceQueues,
      ambiguous: false,
      candidateProjects: [],
      reason: queue ? null : projectQueues.length === 0 ? 'no_queues' : 'queue_not_found',
    };
  }

  // No project given: search the slug across the whole workspace.
  if (input.queueSlug) {
    const hits = queueRows.filter((q) => q.slug === input.queueSlug);
    if (hits.length === 0) {
      const project = projectRows[0];
      return {
        project,
        queue: null,
        projects: projectRows,
        projectQueues: queueRows.filter((q) => q.projectId === project.id),
        workspaceQueues,
        ambiguous: false,
        candidateProjects: [],
        reason: 'queue_not_found' as const,
      };
    }
    const queue = hits[0];
    const project = byId.get(queue.projectId)!;
    const candidateProjects =
      hits.length > 1
        ? projectRows.filter((p) => hits.some((h) => h.projectId === p.id))
        : [];
    return {
      project,
      queue,
      projects: projectRows,
      projectQueues: queueRows.filter((q) => q.projectId === project.id),
      workspaceQueues,
      ambiguous: hits.length > 1,
      candidateProjects,
      reason: null,
    };
  }

  // Nothing given: the first queue of the first project that has one.
  const project =
    projectRows.find((p) => queueRows.some((q) => q.projectId === p.id)) ?? projectRows[0];
  const projectQueues = queueRows.filter((q) => q.projectId === project.id);
  return {
    project,
    queue: projectQueues[0] ?? null,
    projects: projectRows,
    projectQueues,
    workspaceQueues,
    ambiguous: false,
    candidateProjects: [],
    reason: projectQueues.length === 0 ? 'no_queues' : null,
  };
}

export interface QueueRow {
  request: typeof reviewRequests.$inferSelect;
  lease: { userId: string; expiresAt: Date } | null;
  sticky: boolean;
  rankRationale: string;
}

export async function rankedQueue(db: DbOrTx, queueId: string, userId: string): Promise<QueueRow[]> {
  const queue = await db.query.queues.findFirst({ where: eq(queues.id, queueId) });
  const pv = queue?.activePolicyVersionId
    ? await db.query.policyVersions.findFirst({
        where: eq(policyVersions.id, queue.activePolicyVersionId),
      })
    : null;
  const policy = parsePolicyConfig(pv?.config ?? {});
  const rules = policy.rankingRules;

  const orderSql = [
    sql`case when ${reviewRequests.stickyReviewerId} = ${userId} then 0 else 1 end`,
  ];
  for (const rule of rules) {
    if (rule === 'sla') orderSql.push(sql`${reviewRequests.slaDueAt} asc nulls last`);
    else if (rule === 'priority') orderSql.push(asc(reviewRequests.priority));
    else if (rule === 'judge_confidence')
      orderSql.push(sql`${reviewRequests.judgeOverallScore} asc nulls last`);
    else orderSql.push(asc(reviewRequests.createdAt));
  }

  const rows = await db
    .select({ request: reviewRequests, lease: leases })
    .from(reviewRequests)
    .leftJoin(leases, eq(leases.requestId, reviewRequests.id))
    .where(
      and(
        eq(reviewRequests.queueId, queueId),
        inArray(reviewRequests.status, ['open', 'claimed']),
        isNull(reviewRequests.archivedAt)
      )
    )
    .orderBy(...orderSql);

  const now = Date.now();
  return rows.map(({ request, lease }) => {
    const liveLease = lease && lease.expiresAt.getTime() > now ? lease : null;
    const sticky = request.stickyReviewerId === userId && request.round > 1;
    const parts = [
      sticky ? 'sticky: returning to you' : null,
      request.slaDueAt ? `sla ${request.slaDueAt.toISOString()}` : 'no sla',
      `priority P${request.priority}`,
      request.judgeOverallScore != null
        ? `judge ${request.judgeOverallScore.toFixed(2)}`
        : 'judge —',
      'fifo',
    ].filter(Boolean);
    return {
      request,
      lease: liveLease ? { userId: liveLease.userId, expiresAt: liveLease.expiresAt } : null,
      sticky,
      rankRationale: parts.join(' · '),
    };
  });
}

/**
 * Atomic claim: locks the request row; exactly one concurrent claimer wins.
 * Losing claimers get a 409 race error (the queue UI auto-advances focus).
 */
/**
 * Archive requests in bulk — take them off the queue without a verdict.
 *
 * 425 open requests landed in one batch, and some accounts get killed outright.
 * The only way to clear a row used to be to review it.
 *
 * Archive is a soft state and never a delete: versions, decisions and events
 * reference the request, and the chain is the product. Each request gets its
 * own `request.archived` event on its own chain, so an archive is as auditable
 * as a verdict. An already-archived request is skipped, so a repeated call is
 * safe.
 */
export async function archiveRequests(
  db: Db,
  input: { requestIds: string[]; userId: string; reason?: string }
): Promise<{ archived: string[]; skipped: string[] }> {
  if (input.requestIds.length === 0) return { archived: [], skipped: [] };
  return db.transaction(async (tx) => {
    // Lock in id order so two overlapping batches cannot deadlock, then skip
    // anything already archived. The UPDATE is also gated on archived_at IS
    // NULL so a concurrent archive cannot append a second signed event.
    const rows = await tx
      .select()
      .from(reviewRequests)
      .where(inArray(reviewRequests.id, input.requestIds))
      .orderBy(asc(reviewRequests.id))
      .for('update');

    const archived: string[] = [];
    const skipped: string[] = [];
    const at = new Date();
    for (const request of rows) {
      if (request.archivedAt) {
        skipped.push(request.id);
        continue;
      }
      const [updated] = await tx
        .update(reviewRequests)
        .set({ archivedAt: at, archivedBy: input.userId, updatedAt: at })
        .where(and(eq(reviewRequests.id, request.id), isNull(reviewRequests.archivedAt)))
        .returning();
      if (!updated) {
        skipped.push(request.id);
        continue;
      }
      await tx.delete(leases).where(eq(leases.requestId, request.id));
      await appendEvent(tx, request.id, 'request.archived', {
        by: input.userId,
        status_at_archive: request.status,
        round: request.round,
        batch_size: input.requestIds.length,
        reason: input.reason ?? null,
      });
      archived.push(request.id);
    }
    // An id that names nothing, or a request in another workspace the caller
    // could not see, is reported rather than silently dropped.
    const found = new Set(rows.map((r) => r.id));
    for (const id of input.requestIds) if (!found.has(id)) skipped.push(id);
    return { archived, skipped };
  });
}

/**
 * Put archived requests back on the board.
 *
 * The exact reversal of `archiveRequests`. Archive never touched `status`, so
 * unarchive does not either: an `open` request returns to the queue and a
 * `rejected` one returns to the awaiting-version list, each exactly where it
 * was. Anything else would silently discard a decision the pipeline may still
 * be acting on.
 *
 * A request that is not archived is skipped, so a repeated call is safe.
 */
export async function unarchiveRequests(
  db: Db,
  input: { requestIds: string[]; userId: string; reason?: string }
): Promise<{ unarchived: string[]; skipped: string[] }> {
  if (input.requestIds.length === 0) return { unarchived: [], skipped: [] };
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(reviewRequests)
      .where(inArray(reviewRequests.id, input.requestIds));

    const unarchived: string[] = [];
    const skipped: string[] = [];
    const at = new Date();
    for (const request of rows) {
      if (!request.archivedAt) {
        skipped.push(request.id);
        continue;
      }
      await tx
        .update(reviewRequests)
        .set({ archivedAt: null, archivedBy: null, updatedAt: at })
        .where(eq(reviewRequests.id, request.id));
      await appendEvent(tx, request.id, 'request.unarchived', {
        by: input.userId,
        archived_by: request.archivedBy,
        archived_at: request.archivedAt.toISOString(),
        status_restored: request.status,
        batch_size: input.requestIds.length,
        reason: input.reason ?? null,
      });
      unarchived.push(request.id);
    }
    const found = new Set(rows.map((r) => r.id));
    for (const id of input.requestIds) if (!found.has(id)) skipped.push(id);
    return { unarchived, skipped };
  });
}

/** Archived requests for one queue, newest first. The operator's undo list. */
export async function archivedForQueue(db: DbOrTx, queueId: string) {
  return db
    .select()
    .from(reviewRequests)
    .where(and(eq(reviewRequests.queueId, queueId), isNotNull(reviewRequests.archivedAt)))
    .orderBy(desc(reviewRequests.archivedAt), asc(reviewRequests.id));
}

export async function claim(db: Db, requestId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, requestId))
      .for('update');
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (request.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');
    if (request.status !== 'open')
      throw new ApiProblem(409, 'not_claimable', `Request is ${request.status}`);

    const [existing] = await tx.select().from(leases).where(eq(leases.requestId, requestId));
    if (existing) {
      if (existing.expiresAt.getTime() > Date.now()) {
        throw new ApiProblem(409, 'claim_race', 'Claimed by another reviewer just now');
      }
      await tx.delete(leases).where(eq(leases.id, existing.id));
    }

    const policy = await getPolicyForRequest(tx, request.policyVersionId);
    const expiresAt = new Date(Date.now() + policy.leaseMinutes * 60_000);
    await tx.insert(leases).values({ requestId, userId, expiresAt });
    await tx
      .update(reviewRequests)
      .set({ status: 'claimed', updatedAt: new Date() })
      .where(eq(reviewRequests.id, requestId));
    await appendEvent(tx, requestId, 'request.claimed', { user_id: userId });
    return { expiresAt };
  });
}

export async function release(db: Db, requestId: string, userId: string) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, requestId))
      .for('update');
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (request.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');
    const [lease] = await tx.select().from(leases).where(eq(leases.requestId, requestId));
    if (!lease || lease.userId !== userId)
      throw new ApiProblem(409, 'not_lease_holder', 'You do not hold this lease');
    await tx.delete(leases).where(eq(leases.id, lease.id));
    if (request.status === 'claimed') {
      await tx
        .update(reviewRequests)
        .set({ status: 'open', updatedAt: new Date() })
        .where(eq(reviewRequests.id, requestId));
    }
    await appendEvent(tx, requestId, 'request.released', { user_id: userId });
  });
}

/** Worker sweep: expired leases return their requests to the queue. */
export async function expireLeases(db: Db): Promise<number> {
  const expired = await db.select().from(leases).where(lt(leases.expiresAt, new Date()));
  let count = 0;
  for (const lease of expired) {
    await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(reviewRequests)
        .where(eq(reviewRequests.id, lease.requestId))
        .for('update');
      const [still] = await tx.select().from(leases).where(eq(leases.id, lease.id));
      if (!still || still.expiresAt.getTime() > Date.now()) return;
      await tx.delete(leases).where(eq(leases.id, lease.id));
      if (request?.archivedAt) return;
      if (request && request.status === 'claimed') {
        await tx
          .update(reviewRequests)
          .set({ status: 'open', updatedAt: new Date() })
          .where(eq(reviewRequests.id, request.id));
        await appendEvent(tx, request.id, 'lease.expired', { user_id: lease.userId });
        count++;
      }
    });
  }
  return count;
}

/** Worker sweep: SLA timeouts apply the policy's fail mode with a flagged event. */
export async function applySlaTimeouts(db: Db): Promise<number> {
  const due = await db
    .select()
    .from(reviewRequests)
    .where(
      and(
        inArray(reviewRequests.status, ['open', 'claimed']),
        isNull(reviewRequests.archivedAt),
        lt(reviewRequests.slaDueAt, new Date())
      )
    );
  let count = 0;
  for (const req of due) {
    await db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(reviewRequests)
        .where(eq(reviewRequests.id, req.id))
        .for('update');
      if (!request || request.archivedAt || !['open', 'claimed'].includes(request.status)) return;
      if (!request.slaDueAt || request.slaDueAt.getTime() > Date.now()) return;
      const policy = await getPolicyForRequest(tx, request.policyVersionId);
      const failOpen = policy.slaFailMode === 'fail_open';
      await tx
        .update(reviewRequests)
        .set({ status: failOpen ? 'accepted' : 'escalated', updatedAt: new Date() })
        .where(eq(reviewRequests.id, request.id));
      await tx.delete(leases).where(eq(leases.requestId, request.id));
      await appendEvent(tx, request.id, 'sla.timeout', {
        mode: policy.slaFailMode,
        flagged_unreviewed: true,
      });
      count++;
    });
  }
  return count;
}
