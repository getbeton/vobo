import { desc, eq } from 'drizzle-orm';
import { queues, policyVersions, workspaces, projects } from '@/lib/db/schema';
import { DbOrTx } from './eventlog';
import {
  PolicyConfig,
  parsePolicyConfig,
  resolvePolicy,
  workspaceDefaultsSchema,
} from './policy';
import { stableStringify } from './events';
import { ApiProblem } from './requests';

/**
 * Policy publishing. Two inputs — workspace defaults and per-queue overrides —
 * resolve into ONE full config, which is frozen into an immutable
 * policy_versions row. Requests stamp the active version id at creation, so a
 * policy change never rewrites how an in-flight request was judged: it applies
 * to new rounds only (prototype: "Overrides apply to new rounds").
 */

export interface ResolvedQueuePolicy {
  config: PolicyConfig;
  /** Keys the queue overrides explicitly; everything else is inherited. */
  overrideKeys: string[];
  version: number;
  policyVersionId: string;
}

export async function workspaceDefaultsFor(tx: DbOrTx, workspaceId: number) {
  const ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  return workspaceDefaultsSchema.parse(ws?.policyDefaults ?? {});
}

export async function resolveQueuePolicy(
  tx: DbOrTx,
  queueId: string
): Promise<ResolvedQueuePolicy> {
  const queue = await tx.query.queues.findFirst({ where: eq(queues.id, queueId) });
  if (!queue) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');
  const project = await tx.query.projects.findFirst({ where: eq(projects.id, queue.projectId) });
  if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');

  const defaults = await workspaceDefaultsFor(tx, project.workspaceId);
  const overrides = (queue.policyOverrides ?? {}) as Record<string, unknown>;
  const active = queue.activePolicyVersionId
    ? await tx.query.policyVersions.findFirst({
        where: eq(policyVersions.id, queue.activePolicyVersionId),
      })
    : null;

  return {
    config: resolvePolicy(defaults, overrides),
    overrideKeys: Object.keys(overrides),
    version: active?.version ?? 0,
    policyVersionId: active?.id ?? '',
  };
}

/**
 * Freeze the currently-resolved config as a new policy version, but only when
 * it actually differs from the active one — a no-op edit must not burn a
 * version number (versions are user-visible: "policy v7").
 */
export async function publishQueuePolicy(
  tx: DbOrTx,
  queueId: string,
  userId: string | null
): Promise<{ changed: boolean; version: number; policyVersionId: string }> {
  const resolved = await resolveQueuePolicy(tx, queueId);
  const active = resolved.policyVersionId
    ? await tx.query.policyVersions.findFirst({
        where: eq(policyVersions.id, resolved.policyVersionId),
      })
    : null;

  if (active && stableStringify(parsePolicyConfig(active.config)) === stableStringify(resolved.config)) {
    return { changed: false, version: active.version, policyVersionId: active.id };
  }

  const [latest] = await tx
    .select({ version: policyVersions.version })
    .from(policyVersions)
    .where(eq(policyVersions.queueId, queueId))
    .orderBy(desc(policyVersions.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  const [row] = await tx
    .insert(policyVersions)
    .values({
      queueId,
      version: nextVersion,
      config: resolved.config,
      createdBy: userId,
    })
    .returning();

  await tx
    .update(queues)
    .set({ activePolicyVersionId: row.id })
    .where(eq(queues.id, queueId));

  return { changed: true, version: row.version, policyVersionId: row.id };
}
