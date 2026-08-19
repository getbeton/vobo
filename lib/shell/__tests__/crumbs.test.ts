import { describe, it, expect } from 'vitest';
import {
  readSelection,
  projectTarget,
  queueTarget,
  environmentTarget,
  optionsWithSelection,
  selectedLabel,
} from '../crumbs';

const PICO = {
  slug: 'pico',
  name: 'PICO Outbound',
  queueSlugs: ['pico-cold-email', 'pico-account-pass', 'pico-trial-sites'],
};
const ACME = { slug: 'acme', name: 'Acme Pipelines', queueSlugs: ['support-replies'] };

describe('crumb selection', () => {
  it('reads the selection from the URL, production by default', () => {
    expect(readSelection({})).toEqual({
      projectSlug: null,
      queueSlug: null,
      environment: 'production',
    });
    expect(readSelection({ project: 'pico', queue: 'pico-cold-email', env: 'test' })).toEqual({
      projectSlug: 'pico',
      queueSlug: 'pico-cold-email',
      environment: 'test',
    });
  });

  it('ticks exactly one option', () => {
    const items = PICO.queueSlugs.map((s) => ({ label: s, slug: s, value: `/queue?queue=${s}` }));
    const opts = optionsWithSelection(items, 'pico-account-pass');
    expect(opts.filter((o) => o.selected)).toHaveLength(1);
    expect(opts.find((o) => o.selected)?.label).toBe('pico-account-pass');
  });

  it('takes the label from the URL, not from the first row', () => {
    const items = PICO.queueSlugs.map((s) => ({ label: s, slug: s, value: `/queue?queue=${s}` }));
    const opts = optionsWithSelection(items, 'pico-trial-sites');
    expect(selectedLabel(opts, 'queue')).toBe('pico-trial-sites');
  });

  it('falls to the first option when the URL names an unknown queue', () => {
    const items = PICO.queueSlugs.map((s) => ({ label: s, slug: s, value: `/queue?queue=${s}` }));
    const opts = optionsWithSelection(items, 'ghost');
    expect(opts.filter((o) => o.selected)).toHaveLength(1);
    expect(opts[0].selected).toBe(true);
  });

  it('ticks nothing when there is nothing to tick', () => {
    expect(optionsWithSelection([], 'anything')).toEqual([]);
  });
});

describe('crumb targets', () => {
  const current = readSelection({ project: 'pico', queue: 'pico-cold-email', env: 'production' });

  it('keeps project and environment when the queue changes', () => {
    expect(queueTarget(current, 'pico-account-pass')).toBe(
      '/queue?project=pico&queue=pico-account-pass&env=production'
    );
  });

  it('keeps project and queue when the environment changes', () => {
    // The defect: layout.tsx hard-coded `/queue?env=test`, which dropped the queue.
    expect(environmentTarget(current, 'test')).toBe(
      '/queue?project=pico&queue=pico-cold-email&env=test'
    );
  });

  it('resets the queue when the slug does not exist in the new project', () => {
    expect(projectTarget(current, ACME)).toBe(
      '/queue?project=acme&queue=support-replies&env=production'
    );
  });

  it('keeps the queue slug when the new project also has it', () => {
    const shared = { slug: 'beta', name: 'Beta', queueSlugs: ['pico-cold-email', 'other'] };
    expect(projectTarget(current, shared)).toBe(
      '/queue?project=beta&queue=pico-cold-email&env=production'
    );
  });

  it('carries the environment through a project switch', () => {
    const onTest = readSelection({ project: 'pico', queue: 'pico-cold-email', env: 'test' });
    expect(projectTarget(onTest, ACME)).toBe(
      '/queue?project=acme&queue=support-replies&env=test'
    );
  });

  it('handles a project with no queues', () => {
    const empty = { slug: 'new', name: 'New', queueSlugs: [] };
    expect(projectTarget(current, empty)).toBe('/queue?project=new&env=production');
  });

  it('encodes slugs that need it', () => {
    const odd = { slug: 'a b', name: 'A B', queueSlugs: ['c&d'] };
    expect(projectTarget(current, odd)).toBe('/queue?project=a+b&queue=c%26d&env=production');
  });
});
