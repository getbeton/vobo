import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  queues,
  policyVersions,
  policyTemplates,
  workspaces,
  projects,
  type PolicyTemplate,
  type Queue,
} from '@/lib/db/schema';
import { DbOrTx } from './eventlog';
import {
  PolicyConfig,
  PolicyKey,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_SLUG,
  effectiveSettingSources,
  parsePolicyConfig,
  policyPartialSchema,
  policyVersionStamp,
  resolvePolicy,
  type PolicyLayer,
  type PolicyVersionStamp,
} from './policy';
import { stableStringify } from './events';
import { ApiProblem } from './requests';

/**
 * Policy publishing. Named templates at workspace/project level resolve with
 * per-queue overrides into ONE full config, frozen as an immutable
 * policy_versions row owned by the queue. Requests stamp that live version
 * id at creation (ARD §57.4).
 */

export interface ResolvedQueuePolicy {
  config: PolicyConfig;
  /** Keys the queue overrides explicitly; everything else is inherited. */
  overrideKeys: string[];
  version: number;
  policyVersionId: string;
  templateId: string;
  templateName: string;
  templateSlug: string;
  /** Per-key "inherited from X" / "overridden here". */
  sources: Record<PolicyKey, string>;
  layers: PolicyLayer[];
}

export async function ensureWorkspaceTemplate(
  tx: DbOrTx,
  workspaceId: number,
  opts: { name?: string; slug?: string; config?: unknown } = {}
): Promise<PolicyTemplate> {
  const slug = opts.slug ?? DEFAULT_TEMPLATE_SLUG;
  const existing = await tx.query.policyTemplates.findFirst({
    where: and(
      eq(policyTemplates.workspaceId, workspaceId),
      isNull(policyTemplates.projectId),
      eq(policyTemplates.slug, slug)
    ),
  });
  if (existing) return existing;

  const ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  const config = policyPartialSchema.parse(
    opts.config ?? (slug === DEFAULT_TEMPLATE_SLUG ? (ws?.policyDefaults ?? {}) : {})
  );
  const [row] = await tx
    .insert(policyTemplates)
    .values({
      workspaceId,
      projectId: null,
      parentTemplateId: null,
      name: opts.name ?? (slug === DEFAULT_TEMPLATE_SLUG ? DEFAULT_TEMPLATE_NAME : opts.name ?? slug),
      slug,
      config,
    })
    .returning();
  return row;
}

export async function ensureProjectTemplate(
  tx: DbOrTx,
  projectId: string,
  opts: { name?: string; slug?: string; parentTemplateId?: string; config?: unknown } = {}
): Promise<PolicyTemplate> {
  const slug = opts.slug ?? DEFAULT_TEMPLATE_SLUG;
  const existing = await tx.query.policyTemplates.findFirst({
    where: and(eq(policyTemplates.projectId, projectId), eq(policyTemplates.slug, slug)),
  });
  if (existing) return existing;

  const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');

  const parent =
    opts.parentTemplateId != null
      ? await tx.query.policyTemplates.findFirst({
          where: eq(policyTemplates.id, opts.parentTemplateId),
        })
      : await ensureWorkspaceTemplate(tx, project.workspaceId);

  if (!parent || parent.workspaceId !== project.workspaceId || parent.projectId) {
    throw new ApiProblem(404, 'template_not_found', 'Parent policy template not found');
  }

  const [row] = await tx
    .insert(policyTemplates)
    .values({
      workspaceId: project.workspaceId,
      projectId,
      parentTemplateId: parent.id,
      name: opts.name ?? (slug === DEFAULT_TEMPLATE_SLUG ? DEFAULT_TEMPLATE_NAME : opts.name ?? slug),
      slug,
      config: policyPartialSchema.parse(opts.config ?? {}),
    })
    .returning();
  return row;
}

export async function listWorkspaceTemplates(tx: DbOrTx, workspaceId: number) {
  return tx
    .select()
    .from(policyTemplates)
    .where(and(eq(policyTemplates.workspaceId, workspaceId), isNull(policyTemplates.projectId)))
    .orderBy(asc(policyTemplates.createdAt));
}

export async function listProjectTemplates(tx: DbOrTx, projectId: string) {
  return tx
    .select()
    .from(policyTemplates)
    .where(eq(policyTemplates.projectId, projectId))
    .orderBy(asc(policyTemplates.createdAt));
}

export async function templatesAvailableToProject(tx: DbOrTx, projectId: string) {
  const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
  return tx
    .select()
    .from(policyTemplates)
    .where(
      and(
        eq(policyTemplates.workspaceId, project.workspaceId),
        or(isNull(policyTemplates.projectId), eq(policyTemplates.projectId, projectId))
      )
    )
    .orderBy(asc(policyTemplates.createdAt));
}

export async function getTemplate(tx: DbOrTx, templateId: string): Promise<PolicyTemplate> {
  const row = await tx.query.policyTemplates.findFirst({
    where: eq(policyTemplates.id, templateId),
  });
  if (!row) throw new ApiProblem(404, 'template_not_found', 'Policy template not found');
  return row;
}

/** Project-level slug wins; otherwise the workspace template with that slug. */
export async function findTemplateBySlug(
  tx: DbOrTx,
  projectId: string,
  slug: string
): Promise<PolicyTemplate | undefined> {
  const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return undefined;
  const atProject = await tx.query.policyTemplates.findFirst({
    where: and(eq(policyTemplates.projectId, projectId), eq(policyTemplates.slug, slug)),
  });
  if (atProject) return atProject;
  return tx.query.policyTemplates.findFirst({
    where: and(
      eq(policyTemplates.workspaceId, project.workspaceId),
      isNull(policyTemplates.projectId),
      eq(policyTemplates.slug, slug)
    ),
  });
}

export interface TemplateChain {
  leaf: PolicyTemplate;
  workspace: PolicyTemplate | null;
  project: PolicyTemplate | null;
  layers: PolicyLayer[];
  config: PolicyConfig;
}

export async function resolveTemplateChain(tx: DbOrTx, templateId: string): Promise<TemplateChain> {
  const leaf = await getTemplate(tx, templateId);
  let workspace: PolicyTemplate | null = null;
  let project: PolicyTemplate | null = null;

  if (leaf.projectId) {
    project = leaf;
    if (leaf.parentTemplateId) {
      workspace = (await tx.query.policyTemplates.findFirst({
        where: eq(policyTemplates.id, leaf.parentTemplateId),
      })) ?? null;
    }
  } else {
    workspace = leaf;
  }

  const layers: PolicyLayer[] = [];
  if (workspace) layers.push({ name: workspace.name, config: (workspace.config ?? {}) as Record<string, unknown> });
  if (project) layers.push({ name: project.name, config: (project.config ?? {}) as Record<string, unknown> });

  const config = resolvePolicy(workspace?.config, project?.config);
  return { leaf, workspace, project, layers, config };
}

function queueLayers(chain: TemplateChain, overrides: Record<string, unknown>): PolicyLayer[] {
  return [...chain.layers, { name: 'queue', config: overrides }];
}

export async function resolveQueuePolicy(
  tx: DbOrTx,
  queueId: string
): Promise<ResolvedQueuePolicy> {
  const queue = await tx.query.queues.findFirst({ where: eq(queues.id, queueId) });
  if (!queue) throw new ApiProblem(404, 'queue_not_found', 'Queue not found');

  const chain = await resolveTemplateChain(tx, queue.templateId);
  const overrides = (queue.policyOverrides ?? {}) as Record<string, unknown>;
  const layers = queueLayers(chain, overrides);
  const active = queue.activePolicyVersionId
    ? await tx.query.policyVersions.findFirst({
        where: eq(policyVersions.id, queue.activePolicyVersionId),
      })
    : null;

  return {
    config: resolvePolicy(chain.workspace?.config, chain.project?.config, overrides),
    overrideKeys: Object.keys(overrides),
    version: active?.version ?? 0,
    policyVersionId: active?.id ?? '',
    templateId: chain.leaf.id,
    templateName: chain.leaf.name,
    templateSlug: chain.leaf.slug,
    sources: effectiveSettingSources(layers),
    layers,
  };
}

export function templateSources(chain: TemplateChain): Record<PolicyKey, string> {
  return effectiveSettingSources(chain.layers);
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
): Promise<{ changed: boolean; version: number; policyVersionId: string; templateId: string }> {
  const resolved = await resolveQueuePolicy(tx, queueId);
  const active = resolved.policyVersionId
    ? await tx.query.policyVersions.findFirst({
        where: eq(policyVersions.id, resolved.policyVersionId),
      })
    : null;

  if (active && stableStringify(parsePolicyConfig(active.config)) === stableStringify(resolved.config)) {
    return {
      changed: false,
      version: active.version,
      policyVersionId: active.id,
      templateId: active.templateId,
    };
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
      templateId: resolved.templateId,
      version: nextVersion,
      config: resolved.config,
      createdBy: userId,
    })
    .returning();

  await tx
    .update(queues)
    .set({ activePolicyVersionId: row.id })
    .where(eq(queues.id, queueId));

  return {
    changed: true,
    version: row.version,
    policyVersionId: row.id,
    templateId: row.templateId,
  };
}

export async function stampForPolicyVersion(
  tx: DbOrTx,
  policyVersionId: string
): Promise<PolicyVersionStamp> {
  const pv = await tx.query.policyVersions.findFirst({
    where: eq(policyVersions.id, policyVersionId),
  });
  if (!pv) throw new ApiProblem(500, 'policy_missing', 'Policy version not found');
  return policyVersionStamp(pv);
}

/** Queue ids whose live policy instantiates this template or a child of it. */
export async function queueIdsInstantiating(tx: DbOrTx, templateId: string): Promise<string[]> {
  const children = await tx
    .select({ id: policyTemplates.id })
    .from(policyTemplates)
    .where(eq(policyTemplates.parentTemplateId, templateId));
  const ids = [templateId, ...children.map((c) => c.id)];
  const rows = await tx
    .select({ id: queues.id })
    .from(queues)
    .where(inArray(queues.templateId, ids));
  return rows.map((r) => r.id);
}

export async function republishQueuesForTemplate(
  tx: DbOrTx,
  templateId: string,
  userId: string | null
): Promise<number> {
  const ids = await queueIdsInstantiating(tx, templateId);
  for (const id of ids) await publishQueuePolicy(tx, id, userId);
  return ids.length;
}

export async function patchTemplateConfig(
  tx: DbOrTx,
  templateId: string,
  patch: Record<string, unknown>,
  userId: string | null
): Promise<{ template: PolicyTemplate; republished: number }> {
  const current = await getTemplate(tx, templateId);
  const next: Record<string, unknown> = { ...(current.config as object) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === '__inherit__') delete next[k];
    else next[k] = v;
  }
  const merged = policyPartialSchema.parse(next);
  const [template] = await tx
    .update(policyTemplates)
    .set({ config: merged, updatedAt: new Date() })
    .where(eq(policyTemplates.id, templateId))
    .returning();
  const republished = await republishQueuesForTemplate(tx, templateId, userId);
  return { template, republished };
}

/**
 * A supply request targets a named template, not a live policy (ARD §55.4 / §57.4).
 * The live Policy is still queue-owned: we pick the queue in this project that
 * instantiates the template (or a child of it). `queueSlug` disambiguates when
 * more than one queue instantiates it.
 */
export async function resolveQueueForTemplateSupply(
  tx: DbOrTx,
  input: {
    projectId: string;
    templateSlug: string;
    queueSlug?: string;
    environment?: 'production' | 'test';
  }
): Promise<{ queue: Queue; template: PolicyTemplate }> {
  const template = await findTemplateBySlug(tx, input.projectId, input.templateSlug);
  if (!template) {
    throw new ApiProblem(
      404,
      'template_not_found',
      `Policy template ${input.templateSlug} not found in project`
    );
  }

  const children = await tx
    .select({ id: policyTemplates.id })
    .from(policyTemplates)
    .where(eq(policyTemplates.parentTemplateId, template.id));
  const matchingIds = [template.id, ...children.map((c) => c.id)];

  const env = input.environment ?? 'production';
  const conditions = [
    eq(queues.projectId, input.projectId),
    eq(queues.environment, env),
    inArray(queues.templateId, matchingIds),
  ];
  if (input.queueSlug) conditions.push(eq(queues.slug, input.queueSlug));

  const candidates = await tx.select().from(queues).where(and(...conditions));
  if (candidates.length === 0) {
    throw new ApiProblem(
      404,
      'template_not_instantiated',
      `No ${env} queue in this project instantiates template ${input.templateSlug}`
    );
  }
  if (candidates.length > 1) {
    throw new ApiProblem(
      409,
      'ambiguous_template',
      `Template ${input.templateSlug} is instantiated by more than one queue; pass queue to disambiguate`
    );
  }
  return { queue: candidates[0], template };
}

export function slugifyTemplateName(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || DEFAULT_TEMPLATE_SLUG;
}

export async function createNamedTemplate(
  tx: DbOrTx,
  input: {
    workspaceId: number;
    projectId?: string | null;
    name: string;
    parentTemplateId?: string | null;
    config?: unknown;
  }
): Promise<PolicyTemplate> {
  const name = input.name.trim();
  if (!name) throw new ApiProblem(400, 'invalid_name', 'Template name is required');
  const base = slugifyTemplateName(name);
  let slug = base;
  let n = 2;
  while (true) {
    const clash = input.projectId
      ? await tx.query.policyTemplates.findFirst({
          where: and(eq(policyTemplates.projectId, input.projectId), eq(policyTemplates.slug, slug)),
        })
      : await tx.query.policyTemplates.findFirst({
          where: and(
            eq(policyTemplates.workspaceId, input.workspaceId),
            isNull(policyTemplates.projectId),
            eq(policyTemplates.slug, slug)
          ),
        });
    if (!clash) break;
    slug = `${base}-${n++}`;
  }

  if (input.projectId) {
    return ensureProjectTemplate(tx, input.projectId, {
      name,
      slug,
      parentTemplateId: input.parentTemplateId ?? undefined,
      config: input.config,
    });
  }
  return ensureWorkspaceTemplate(tx, input.workspaceId, { name, slug, config: input.config });
}
