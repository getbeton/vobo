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

export const POLICY_KEYS = [
  'rankingRules',
  'advancementMode',
  'roundBudget',
  'blindN',
  'leaseMinutes',
  'slaMinutes',
  'slaFailMode',
  'stickyRegenerations',
  'judgeEnabled',
  'judgeSamplingPct',
  'judgeBlindSamplingPct',
  'judgeModelId',
  'judgeBaseUrl',
  'judgeKeyEnv',
  'judgeMinScore',
  'judgeBindings',
  'piiDetection',
] as const satisfies ReadonlyArray<keyof PolicyConfig>;

export type PolicyKey = (typeof POLICY_KEYS)[number];

export function parsePolicyConfig(raw: unknown): PolicyConfig {
  return policyConfigSchema.parse(raw);
}

/** Partial overlay — templates and queue overrides store only keys they set. */
export const policyPartialSchema = policyConfigSchema.partial();
export type PolicyPartial = z.infer<typeof policyPartialSchema>;

/** @deprecated Use policyPartialSchema. Kept so existing callers compile. */
export const workspaceDefaultsSchema = policyPartialSchema;
export type WorkspaceDefaults = PolicyPartial;

export const DEFAULT_TEMPLATE_SLUG = 'default';
export const DEFAULT_TEMPLATE_NAME = 'Default';
export const VOBO_DEFAULTS_NAME = 'Vobo defaults';

export interface PolicyLayer {
  /** Display name used in "inherited from X". */
  name: string;
  config: Record<string, unknown>;
}

function layerSets(layer: PolicyLayer, key: PolicyKey): boolean {
  return Object.prototype.hasOwnProperty.call(layer.config, key) && layer.config[key] !== undefined;
}

/**
 * Effective-setting source on every entity page (ARD §47.2 / §57.4).
 * `layers` run ancestor → here; the last entry is the current entity.
 * Returns exactly "overridden here" or "inherited from X".
 */
export function effectiveSettingSource(key: PolicyKey, layers: PolicyLayer[]): string {
  if (layers.length === 0) return `inherited from ${VOBO_DEFAULTS_NAME}`;
  const here = layers[layers.length - 1];
  if (layerSets(here, key)) return 'overridden here';
  for (let i = layers.length - 2; i >= 0; i--) {
    if (layerSets(layers[i], key)) return `inherited from ${layers[i].name}`;
  }
  return `inherited from ${VOBO_DEFAULTS_NAME}`;
}

export function effectiveSettingSources(layers: PolicyLayer[]): Record<PolicyKey, string> {
  const out = {} as Record<PolicyKey, string>;
  for (const key of POLICY_KEYS) out[key] = effectiveSettingSource(key, layers);
  return out;
}

/**
 * Merge DEFAULT_POLICY ← each overlay (left to right). Overlays are partial.
 * Typical chain: workspace template → project template → queue overrides.
 */
export function resolvePolicy(...overlays: unknown[]): PolicyConfig {
  let acc: Record<string, unknown> = { ...DEFAULT_POLICY };
  for (const raw of overlays) {
    const parsed = policyPartialSchema.parse(raw ?? {});
    acc = { ...acc, ...parsed };
  }
  return policyConfigSchema.parse(acc);
}

/** Stamp carried on signed events: live instance vs named template are distinct fields. */
export interface PolicyVersionStamp {
  policy_version_id: string;
  policy_version: number;
  policy_template_id: string;
}

export function policyVersionStamp(pv: {
  id: string;
  version: number;
  templateId: string;
}): PolicyVersionStamp {
  return {
    policy_version_id: pv.id,
    policy_version: pv.version,
    policy_template_id: pv.templateId,
  };
}
