import { z } from 'zod';

/**
 * Queue policy config — the one deliberate JSON settings column (ARD §4).
 * Every change creates a new immutable policy_versions row; the active version
 * id is stamped onto each ReviewRequest at creation and carried into every
 * signed event.
 */

export const rankingRuleSchema = z.enum(['sla', 'priority', 'fifo']);
export type RankingRule = z.infer<typeof rankingRuleSchema>;

export const policyConfigSchema = z.object({
  /** Ordered, composable ranking rules. Reviewers never configure sorting. */
  rankingRules: z.array(rankingRuleSchema).min(1).default(['sla', 'priority', 'fifo']),
  /** auto: verdict submit opens next item. manual: back to the queue list. */
  advancementMode: z.enum(['auto', 'manual']).default('manual'),
  /** Rejecting past this round forces escalate (thrash guard). */
  roundBudget: z.number().int().min(1).max(20).default(3),
  /** 0 = off. Schema-level support only in MVP; no adjudication UI. */
  blindN: z.number().int().min(0).max(5).default(0),
  /** Lease TTL for a claim, minutes. */
  leaseMinutes: z.number().int().min(5).max(24 * 60).default(240),
  /** SLA window from request creation, minutes. null = no SLA. */
  slaMinutes: z.number().int().min(1).nullable().default(null),
  /** What happens at SLA timeout. */
  slaFailMode: z.enum(['fail_open', 'fail_closed']).default('fail_closed'),
  /** Regenerations return to the reviewer who rejected (queue-top). */
  stickyRegenerations: z.boolean().default(true),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export const DEFAULT_POLICY: PolicyConfig = policyConfigSchema.parse({});

export function parsePolicyConfig(raw: unknown): PolicyConfig {
  return policyConfigSchema.parse(raw);
}

/** Workspace-level defaults that projects/queues inherit (subset of policy). */
export const workspaceDefaultsSchema = policyConfigSchema.partial();
export type WorkspaceDefaults = z.infer<typeof workspaceDefaultsSchema>;

export function resolvePolicy(
  workspaceDefaults: unknown,
  queueConfig: unknown
): PolicyConfig {
  const ws = workspaceDefaultsSchema.parse(workspaceDefaults ?? {});
  const q = policyConfigSchema.partial().parse(queueConfig ?? {});
  return policyConfigSchema.parse({ ...DEFAULT_POLICY, ...ws, ...q });
}
