import { describe, it, expect } from 'vitest';
import {
  readSelection,
  projectTarget,
  queueTarget,
  environmentTarget,
  optionsWithSelection,
  selectedLabel,
  selectProject,
  queueListHref,
  reviewHref,
  mergeReviewSearch,
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

describe('project selection follows the resolver', () => {
  // resolveQueue searches the whole workspace for a slug. If the crumb fell to
  // the first project instead, the breadcrumb would name one project while the
  // body rendered a queue from another.
  const projects = [ACME, PICO];

  it('picks the project that owns the queue slug when no project is given', () => {
    const sel = readSelection({ queue: 'pico-cold-email' });
    expect(selectProject(projects, sel)?.slug).toBe('pico');
  });

  it('lets an explicit project win over the slug owner', () => {
    const sel = readSelection({ project: 'acme', queue: 'pico-cold-email' });
    expect(selectProject(projects, sel)?.slug).toBe('acme');
  });

  it('falls to the first project when nothing is given', () => {
    expect(selectProject(projects, readSelection({}))?.slug).toBe('acme');
  });

  it('falls to the first project when the slug is in no project', () => {
    expect(selectProject(projects, readSelection({ queue: 'ghost' }))?.slug).toBe('acme');
  });

  it('returns null when the workspace has no projects', () => {
    expect(selectProject([], readSelection({ queue: 'x' }))).toBeNull();
  });
});

const CRO = {
  projectSlug: 'pico',
  queueSlug: 'pico-cro-w2b-cold-email',
  environment: 'production' as const,
};

describe('VOBO-269: review and queue href helpers', () => {
  it('queueListHref is the three-param list, never bare /queue', () => {
    expect(queueListHref(CRO)).toBe(
      '/queue?project=pico&queue=pico-cro-w2b-cold-email&env=production'
    );
  });

  it('reviewHref carries the same three params', () => {
    expect(reviewHref('abc', CRO)).toBe(
      '/review/abc?project=pico&queue=pico-cro-w2b-cold-email&env=production'
    );
  });

  it('reviewHref compare keeps l and r', () => {
    expect(reviewHref('abc', CRO, { compare: true, l: 1, r: 2 })).toBe(
      '/review/abc/compare?project=pico&queue=pico-cro-w2b-cold-email&env=production&l=1&r=2'
    );
  });

  it('mergeReviewSearch fills missing project/queue/env and keeps l/r', () => {
    const filled = mergeReviewSearch({ l: '1', r: '2' }, CRO);
    expect(filled.changed).toBe(true);
    expect(filled.search).toBe(
      'project=pico&queue=pico-cro-w2b-cold-email&env=production&l=1&r=2'
    );
  });

  it('mergeReviewSearch is a no-op when the three params are already set', () => {
    const filled = mergeReviewSearch(
      { project: 'pico', queue: 'pico-cro-w2b-cold-email', env: 'production', l: '1', r: '2' },
      CRO
    );
    expect(filled.changed).toBe(false);
    expect(filled.search).toBe(
      'project=pico&queue=pico-cro-w2b-cold-email&env=production&l=1&r=2'
    );
  });

  it('bare /queue default is unchanged: empty selection still falls to the first project', () => {
    expect(selectProject([ACME, PICO], readSelection({}))?.slug).toBe('acme');
  });
});
