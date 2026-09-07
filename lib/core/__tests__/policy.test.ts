import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POLICY,
  effectiveSettingSource,
  effectiveSettingSources,
  policyVersionStamp,
  resolvePolicy,
} from '../policy';

describe('resolvePolicy', () => {
  it('merges DEFAULT ← workspace template ← project template ← queue overrides', () => {
    const resolved = resolvePolicy(
      { roundBudget: 4, blindN: 2 },
      { roundBudget: 5 },
      { slaMinutes: 60 }
    );
    expect(resolved.roundBudget).toBe(5);
    expect(resolved.blindN).toBe(2);
    expect(resolved.slaMinutes).toBe(60);
    expect(resolved.stickyRegenerations).toBe(DEFAULT_POLICY.stickyRegenerations);
  });
});

describe('effectiveSettingSource', () => {
  const layers = [
    { name: 'Default', config: { roundBudget: 4, blindN: 2 } },
    { name: 'Strict', config: { roundBudget: 2 } },
    { name: 'queue', config: { slaMinutes: 60 } },
  ];

  it('returns overridden here when the current entity sets the key', () => {
    expect(effectiveSettingSource('slaMinutes', layers)).toBe('overridden here');
    expect(effectiveSettingSource('roundBudget', layers.slice(0, 2))).toBe('overridden here');
  });

  it('names the template the value is inherited from', () => {
    expect(effectiveSettingSource('roundBudget', layers)).toBe('inherited from Strict');
    expect(effectiveSettingSource('blindN', layers)).toBe('inherited from Default');
  });

  it('falls back to Vobo defaults when no template sets the key', () => {
    expect(effectiveSettingSource('leaseMinutes', layers)).toBe('inherited from Vobo defaults');
  });

  it('covers every policy key', () => {
    const sources = effectiveSettingSources(layers);
    expect(sources.stickyRegenerations).toBe('inherited from Vobo defaults');
    expect(sources.roundBudget).toBe('inherited from Strict');
  });
});

describe('policyVersionStamp', () => {
  it('keeps live instance id and template id in distinct fields', () => {
    const stamp = policyVersionStamp({
      id: 'live-uuid',
      version: 7,
      templateId: 'template-uuid',
    });
    expect(stamp).toEqual({
      policy_version_id: 'live-uuid',
      policy_version: 7,
      policy_template_id: 'template-uuid',
    });
    expect(stamp.policy_version_id).not.toBe(stamp.policy_template_id);
  });
});
