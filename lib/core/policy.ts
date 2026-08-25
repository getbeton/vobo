import { z } from 'zod';

/**
 * Queue policy config — the one deliberate JSON settings column (ARD §4).
 * Every change creates a new immutable policy_versions row; the active version
 * id is stamped onto each ReviewRequest at creation and carried into every
 * signed event.
 */

export const rankingRuleSchema = z.enum(['sla', 'priority', 'fifo', 'judge_confidence']);
export type RankingRule = z.infer<typeof rankingRuleSchema>;

export const judgeBindingSchema = z.object({
  criterionKey: z.string().min(1),
  /** autoevals scorer name. `closed_qa` is the default for a rubric line. */
  scorer: z.string().min(1).default('closed_qa'),
});
export type JudgeBinding = z.infer<typeof judgeBindingSchema>;

export const policyConfigSchema = z.object({
  /** Ordered, composable ranking rules. Reviewers never configure sorting. */
  rankingRules: z.array(rankingRuleSchema).min(1).default(['sla', 'priority', 'fifo']),
  /** auto: verdict submit opens next item. manual: back to the queue list. */
  advancementMode: z.enum(['auto', 'manual']).default('manual'),
  /** The Xth reject at this round ships and flags the request for an operator. */
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

  /** Run the built-in judge on submitted versions. Off by default. */
  judgeEnabled: z.boolean().default(false),
  /** 0–100. Hash of the version id vs this percentage. 100 = every version. */
  judgeSamplingPct: z.number().int().min(0).max(100).default(100),
  /**
   * 0–100. Hash of the request id vs this percentage, stamped at creation.
   * The judge still runs; reviewers never see its output (ARD §26). Default off.
   */
  judgeBlindSamplingPct: z.number().int().min(0).max(100).default(0),
  judgeModelId: z.string().min(1).default('gpt-4o-mini'),
  judgeBaseUrl: z.string().min(1).default('https://api.openai.com/v1'),
  /** Name of the env var that holds the BYO key. The key never lives in policy. */
  judgeKeyEnv: z.string().min(1).default('VOBO_JUDGE_OPENAI_API_KEY'),
  /** Score below this (0–1) becomes a finding. */
  judgeMinScore: z.number().min(0).max(1).default(0.5),
  /**
   * Per-criterion autoevals scorer. Empty means every active criterion is
   * bound to `closed_qa` using the criterion description as the rubric.
   */
  judgeBindings: z.array(judgeBindingSchema).default([]),
  /** Cheap regex PII producer on every submitted version. */
  piiDetection: z.boolean().default(true),
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
