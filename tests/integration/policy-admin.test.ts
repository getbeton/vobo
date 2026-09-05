import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { queues, policyVersions, policyTemplates, reviewRequests, events } from '@/lib/db/schema';
import {
  createNamedTemplate,
  ensureWorkspaceTemplate,
  patchTemplateConfig,
  publishQueuePolicy,
  resolveQueueForTemplateSupply,
  resolveQueuePolicy,
  resolveTemplateChain,
} from '@/lib/core/policy-store';
import { createReview, ApiProblem } from '@/lib/core/requests';
import { DEFAULT_TEMPLATE_SLUG } from '@/lib/core/policy';

/**
 * Policy administration: named templates at workspace and project level
 * instantiate a singular queue-owned live Policy. Supply targets a template.
 */

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({ roundBudget: 3, slaMinutes: null });
});

async function setOverrides(queueId: string, overrides: Record<string, unknown>) {
  await db.update(queues).set({ policyOverrides: overrides }).where(eq(queues.id, queueId));
}

describe('named templates', () => {
  it('creates a workspace-level Default template as a first-class named object', async () => {
    const tpl = await db.query.policyTemplates.findFirst({
      where: eq(policyTemplates.id, fx.workspaceTemplateId),
    });
    expect(tpl).toMatchObject({
      id: fx.workspaceTemplateId,
      workspaceId: fx.workspaceId,
      projectId: null,
      name: 'Default',
      slug: DEFAULT_TEMPLATE_SLUG,
    });
  });

  it('creates a project-level Default template that inherits from the workspace template', async () => {
    const tpl = await db.query.policyTemplates.findFirst({
      where: eq(policyTemplates.id, fx.projectTemplateId),
    });
    expect(tpl).toMatchObject({
      projectId: fx.projectId,
      parentTemplateId: fx.workspaceTemplateId,
      name: 'Default',
      slug: DEFAULT_TEMPLATE_SLUG,
    });
    const chain = await resolveTemplateChain(db, tpl!.id);
    expect(chain.workspace?.id).toBe(fx.workspaceTemplateId);
    expect(chain.project?.id).toBe(fx.projectTemplateId);
  });

  it('lets a workspace hold more than one named template', async () => {
    const extra = await createNamedTemplate(db, {
      workspaceId: fx.workspaceId,
      name: 'Strict review',
    });
    expect(extra.slug).toBe('strict-review');
    expect(extra.projectId).toBeNull();
    const again = await ensureWorkspaceTemplate(db, fx.workspaceId, { slug: extra.slug });
    expect(again.id).toBe(extra.id);
  });
});

describe('live Policy is queue-owned and instantiated from a template', () => {
  it('binds the queue to one template and freezes a singular live version', async () => {
    const queue = await db.query.queues.findFirst({ where: eq(queues.id, fx.queueId) });
    expect(queue?.templateId).toBe(fx.projectTemplateId);
    expect(queue?.activePolicyVersionId).toBe(fx.policyVersionId);
    const pv = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, fx.policyVersionId),
    });
    expect(pv?.queueId).toBe(fx.queueId);
    expect(pv?.templateId).toBe(fx.projectTemplateId);
    expect(pv?.id).not.toBe(pv?.templateId);
  });

  it('shows inherited from X / overridden here on every setting', async () => {
    await patchTemplateConfig(db, fx.workspaceTemplateId, { roundBudget: 4, blindN: 2 }, fx.userId);
    await setOverrides(fx.queueId, { roundBudget: 2 });
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(2);
    expect(resolved.config.blindN).toBe(2);
    expect(resolved.sources.roundBudget).toBe('overridden here');
    expect(resolved.sources.blindN).toBe('inherited from Default');
    expect(resolved.sources.leaseMinutes).toBe('inherited from Vobo defaults');
  });

  it('lets a project template override a workspace template key', async () => {
    await patchTemplateConfig(db, fx.workspaceTemplateId, { roundBudget: 4 }, fx.userId);
    await patchTemplateConfig(db, fx.projectTemplateId, { roundBudget: 5 }, fx.userId);
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(5);
    expect(resolved.sources.roundBudget).toBe('inherited from Default');
    expect(resolved.templateId).toBe(fx.projectTemplateId);
  });
});

describe('policy resolution', () => {
  it('inherits workspace template values when the queue overrides nothing', async () => {
    await patchTemplateConfig(db, fx.workspaceTemplateId, { roundBudget: 4 }, fx.userId);
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(4);
    expect(resolved.overrideKeys).toEqual([]);
  });

  it('lets a queue override a single key without touching the rest', async () => {
    await patchTemplateConfig(
      db,
      fx.workspaceTemplateId,
      { roundBudget: 4, blindN: 2 },
      fx.userId
    );
    await setOverrides(fx.queueId, { roundBudget: 2 });
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(2);
    expect(resolved.config.blindN).toBe(2);
    expect(resolved.overrideKeys).toEqual(['roundBudget']);
  });
});

describe('publishQueuePolicy', () => {
  it('publishes a new version when the resolved config changes', async () => {
    await setOverrides(fx.queueId, { roundBudget: 2 });
    const res = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(res.changed).toBe(true);
    expect(res.version).toBe(2);
    expect(res.templateId).toBe(fx.projectTemplateId);

    const queue = await db.query.queues.findFirst({ where: eq(queues.id, fx.queueId) });
    expect(queue?.activePolicyVersionId).toBe(res.policyVersionId);

    const pv = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, res.policyVersionId),
    });
    expect((pv!.config as { roundBudget: number }).roundBudget).toBe(2);
    expect(pv!.templateId).toBe(fx.projectTemplateId);
  });

  it('is a no-op when nothing actually changed — version numbers are user-visible', async () => {
    const first = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(first.changed).toBe(false);
    const again = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(again.changed).toBe(false);
    expect(again.version).toBe(1);
  });

  it('never mutates a published version — it appends a new one', async () => {
    const original = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, fx.policyVersionId),
    });
    await setOverrides(fx.queueId, { roundBudget: 4 });
    await publishQueuePolicy(db, fx.queueId, fx.userId);

    const after = await db.query.policyVersions.findFirst({
      where: eq(policyVersions.id, fx.policyVersionId),
    });
    expect(after!.config).toEqual(original!.config);

    const all = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.queueId, fx.queueId));
    expect(all).toHaveLength(2);
  });

  it('leaves in-flight requests on the version they were stamped with', async () => {
    const created = await createReview(db, {
      projectId: fx.projectId,
      templateSlug: 'default',
      queueSlug: 'q',
      customerRequestId: 'pico/acme/email-1',
      title: 'Acme email',
      contentMd: 'Hello there.',
    });
    const before = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, created.request.id),
    });

    await setOverrides(fx.queueId, { roundBudget: 4 });
    const published = await publishQueuePolicy(db, fx.queueId, fx.userId);

    const after = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, created.request.id),
    });
    expect(after!.policyVersionId).toBe(before!.policyVersionId);
    expect(after!.policyVersionId).not.toBe(published.policyVersionId);
  });

  it('propagates a workspace-template change into an inheriting queue', async () => {
    await db
      .update(policyTemplates)
      .set({ config: { roundBudget: 4 }, updatedAt: new Date() })
      .where(eq(policyTemplates.id, fx.workspaceTemplateId));
    const res = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(res.changed).toBe(true);
    const resolved = await resolveQueuePolicy(db, fx.queueId);
    expect(resolved.config.roundBudget).toBe(4);
    expect(resolved.version).toBe(2);
  });

  it('does not propagate a workspace template into a queue that overrides that key', async () => {
    await setOverrides(fx.queueId, { roundBudget: 2 });
    await publishQueuePolicy(db, fx.queueId, fx.userId);
    await patchTemplateConfig(db, fx.workspaceTemplateId, { roundBudget: 4 }, fx.userId);
    const res = await publishQueuePolicy(db, fx.queueId, fx.userId);
    expect(res.changed).toBe(false);
    expect((await resolveQueuePolicy(db, fx.queueId)).config.roundBudget).toBe(2);
  });
});

describe('supply targets a template, not a live policy', () => {
  it('creates a request by template slug and stamps the queue-owned live version', async () => {
    const created = await createReview(db, {
      projectId: fx.projectId,
      templateSlug: 'default',
      customerRequestId: 'pico/acme/email-1',
      title: 'Acme email',
      contentMd: 'Hello there.',
    });
    expect(created.created).toBe(true);
    expect(created.request.queueId).toBe(fx.queueId);
    expect(created.request.policyVersionId).toBe(fx.policyVersionId);

    const [createdEvent] = await db
      .select()
      .from(events)
      .where(eq(events.requestId, created.request.id));
    const payload = createdEvent.payload as Record<string, unknown>;
    expect(payload.policy_version_id).toBe(fx.policyVersionId);
    expect(payload.policy_template_id).toBe(fx.projectTemplateId);
    expect(payload.policy_version).toBe(1);
    expect(payload.policy_version_id).not.toBe(payload.policy_template_id);
  });

  it('rejects an unknown template slug', async () => {
    await expect(
      createReview(db, {
        projectId: fx.projectId,
        templateSlug: 'does-not-exist',
        customerRequestId: 'x',
        title: 'x',
        contentMd: 'x',
      })
    ).rejects.toMatchObject({ status: 404, code: 'template_not_found' } satisfies Partial<ApiProblem>);
  });

  it('resolves supply to the queue that instantiates the named template', async () => {
    const hit = await resolveQueueForTemplateSupply(db, {
      projectId: fx.projectId,
      templateSlug: 'default',
      environment: 'production',
    });
    expect(hit.queue.id).toBe(fx.queueId);
    expect(hit.template.id).toBe(fx.projectTemplateId);
  });
});
