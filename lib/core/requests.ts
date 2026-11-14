import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  reviewRequests,
  artifactVersions,
  annotations,
  anchorStates,
  requestTags,
  queues,
  projects,
  workspaces,
  policyVersions,
  versionResponses,
} from '@/lib/db/schema';
import { appendEvent, DbOrTx, Db } from './eventlog';
import { applyConfirmation } from '@/lib/anchoring/classify';
import { classifyFor } from '@/lib/modality/selectors';
import { DEFAULT_MODALITY } from '@/lib/modality/types';
import { DEFAULT_TEMPLATE_SLUG, parsePolicyConfig, PolicyConfig } from './policy';
import { resolveQueueForTemplateSupply, stampForPolicyVersion } from './policy-store';
import { getStorage } from '@/lib/storage';
import { enqueueJudgeRun } from '@/lib/judge/enqueue';
import { isAwaitingVersion, REOPEN_EVENT_TYPE } from './pull-contract';
import {
  MARKDOWN_BODY_PATH,
  commitContent,
  deriveCommitmentKey,
} from './commitment';

export class ApiProblem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

function artifactModalityOf(input: { modality?: string }): string {
  return input.modality ?? DEFAULT_MODALITY;
}

function assertModalityMatch(queueModality: string, artifactModality: string) {
  if (queueModality !== artifactModality) {
    throw new ApiProblem(
      409,
      'modality_mismatch',
      `Artifact modality '${artifactModality}' does not match queue modality '${queueModality}'`
    );
  }
}

/** Artifacts above this size classify asynchronously (decision 2A guard). */
export const SYNC_CLASSIFY_LIMIT = 500 * 1024;

/** Re-anchor every live annotation onto a new version. Used by submit and by Save. */
export async function classifyLiveOntoVersion(
  tx: DbOrTx,
  input: {
    requestId: string;
    prevContentMd: string;
    nextContentMd: string;
    nextVersionId: string;
  }
): Promise<{ resolved: number; persisting: number; orphaned: number }> {
  const counters = { resolved: 0, persisting: 0, orphaned: 0 };
  if (input.nextContentMd.length > SYNC_CLASSIFY_LIMIT) return counters;

  const request = await tx.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, input.requestId),
  });
  const queue = request
    ? await tx.query.queues.findFirst({ where: eq(queues.id, request.queueId) })
    : null;
  const modality = queue?.modality ?? DEFAULT_MODALITY;

  const live = await tx
    .select()
    .from(annotations)
    .where(and(eq(annotations.requestId, input.requestId), isNull(annotations.retiredAt)));

  for (const ann of live) {
    const computed = applyConfirmation(
      classifyFor(
        modality,
        {
          quote: ann.quote,
          prefix: ann.prefix,
          suffix: ann.suffix,
          startPos: ann.startPos,
          endPos: ann.endPos,
        },
        input.prevContentMd,
        input.nextContentMd
      ),
      null
    );
    counters[computed.state] += 1;

    await tx
      .insert(anchorStates)
      .values({
        annotationId: ann.id,
        versionId: input.nextVersionId,
        state: computed.state,
        confidence: computed.confidence,
        newQuote: computed.landing?.quote ?? null,
        newStartPos: computed.landing?.start ?? null,
        newEndPos: computed.landing?.end ?? null,
      })
      .onConflictDoNothing();

    if (computed.state === 'persisting' && computed.landing) {
      const p = input.nextContentMd;
      await tx
        .update(annotations)
        .set({
          quote: computed.landing.quote,
          startPos: computed.landing.start,
          endPos: computed.landing.end,
          prefix: p.slice(Math.max(0, computed.landing.start - 32), computed.landing.start),
          suffix: p.slice(computed.landing.end, computed.landing.end + 32),
        })
        .where(eq(annotations.id, ann.id));
    }
  }
  return counters;
}

export interface CreateReviewInput {
  projectId: string;
  queueSlug?: string;
  /** Named policy template slug. Defaults to the project's Default template. */
  templateSlug?: string;
  environment?: 'production' | 'test';
  customerRequestId: string;
  title: string;
  contentMd: string;
  /** Declared artifact modality. Defaults to text (content_md). */
  modality?: string;
  prompt?: string;
  source?: string;
  priority?: number;
  authorLabel?: string;
  pipelineRunId?: string;
  traceId?: string;
  tags?: string[];
}

export async function getPolicyForRequest(dbh: DbOrTx, policyVersionId: string): Promise<PolicyConfig> {
  const pv = await dbh.query.policyVersions.findFirst({
    where: eq(policyVersions.id, policyVersionId),
  });
  if (!pv) throw new ApiProblem(500, 'policy_missing', 'Policy version not found');
  return parsePolicyConfig(pv.config);
}

export async function workspaceRootForRequest(tx: DbOrTx, requestId: string) {
  const [row] = await tx
    .select({ id: workspaces.id, rootKey: workspaces.rootKey })
    .from(reviewRequests)
    .innerJoin(projects, eq(projects.id, reviewRequests.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(eq(reviewRequests.id, requestId))
    .limit(1);
  if (!row) throw new ApiProblem(404, 'request_not_found', 'Request not found');
  return row;
}

export async function insertCommittedVersion(
  tx: DbOrTx,
  values: {
    requestId: string;
    versionNumber: number;
    contentMd: string;
    authorKind?: 'model' | 'human';
    authorLabel?: string | null;
    humanAuthored?: boolean;
    filePath?: string;
  }
) {
  const id = randomUUID();
  const { rootKey } = await workspaceRootForRequest(tx, values.requestId);
  const filePath = values.filePath ?? MARKDOWN_BODY_PATH;
  const commitmentKey = deriveCommitmentKey(rootKey, id, filePath);
  const contentHash = commitContent(commitmentKey, values.contentMd);
  const [version] = await tx
    .insert(artifactVersions)
    .values({
      id,
      requestId: values.requestId,
      versionNumber: values.versionNumber,
      authorKind: values.authorKind ?? 'model',
      authorLabel: values.authorLabel,
      contentMd: values.contentMd,
      contentHash,
      commitmentKey,
      humanAuthored: values.humanAuthored ?? false,
    })
    .returning();
  return version;
}

/**
 * `create review` — first-generation method. Idempotent upsert on
 * (project, customer request id): an existing request returns unchanged
 * (created: false); it is never mutated by a repeat call (ARD §9).
 */
export async function createReview(db: Db, input: CreateReviewInput) {
  return db.transaction(async (tx) => {
    const existing = await tx.query.reviewRequests.findFirst({
      where: and(
        eq(reviewRequests.projectId, input.projectId),
        eq(reviewRequests.customerRequestId, input.customerRequestId)
      ),
    });
    if (existing) {
      return { request: existing, created: false as const };
    }

    const project = await tx.query.projects.findFirst({
      where: eq(projects.id, input.projectId),
    });
    if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
    if (project.archivedAt) {
      throw new ApiProblem(409, 'project_archived', 'Project is archived');
    }

    const { queue } = await resolveQueueForTemplateSupply(tx, {
      projectId: input.projectId,
      templateSlug: input.templateSlug ?? DEFAULT_TEMPLATE_SLUG,
      queueSlug: input.queueSlug,
      environment: input.environment,
    });
    if (queue.archivedAt) throw new ApiProblem(409, 'queue_archived', 'Queue is archived');
    if (!queue.openForReview) throw new ApiProblem(409, 'queue_closed', 'Queue is not open for review');
    assertModalityMatch(queue.modality, artifactModalityOf(input));
    if (!queue.activePolicyVersionId)
      throw new ApiProblem(500, 'queue_unconfigured', 'Queue has no active policy version');

    const policy = await getPolicyForRequest(tx, queue.activePolicyVersionId);
    const stamp = await stampForPolicyVersion(tx, queue.activePolicyVersionId);
    const slaDueAt = policy.slaMinutes
      ? new Date(Date.now() + policy.slaMinutes * 60_000)
      : null;

    const [request] = await tx
      .insert(reviewRequests)
      .values({
        projectId: input.projectId,
        queueId: queue.id,
        customerRequestId: input.customerRequestId,
        title: input.title,
        priority: input.priority ?? 3,
        prompt: input.prompt,
        source: input.source,
        pipelineRunId: input.pipelineRunId,
        traceId: input.traceId,
        slaDueAt,
        policyVersionId: queue.activePolicyVersionId,
      })
      .returning();

    const version = await insertCommittedVersion(tx, {
      requestId: request.id,
      versionNumber: 1,
      authorKind: 'model',
      authorLabel: input.authorLabel ?? 'model run',
      contentMd: input.contentMd,
    });
    const hash = version.contentHash;

    if (input.tags?.length) {
      await tx
        .insert(requestTags)
        .values(input.tags.map((tag) => ({ requestId: request.id, tag })))
        .onConflictDoNothing();
    }

    await appendEvent(tx, request.id, 'request.created', {
      customer_request_id: request.customerRequestId,
      queue: queue.slug,
      environment: queue.environment,
      ...stamp,
      title: request.title,
    });
    await appendEvent(tx, request.id, 'version.submitted', {
      version: 1,
      content_hash: hash,
      author: version.authorLabel,
    });

    await enqueueJudgeRun(tx, {
      requestId: request.id,
      versionId: version.id,
      versionNumber: 1,
    });

    try {
      await getStorage().putContent(input.contentMd, 'artifacts');
    } catch (err) {
      console.warn('artifact mirror write failed (non-fatal):', err);
    }

    return { request, created: true as const };
  });
}

export interface SubmitVersionInput {
  projectId: string;
  customerRequestId: string;
  contentMd: string;
  /** Declared artifact modality. Defaults to text (content_md). */
  modality?: string;
  authorLabel?: string;
  /** Per-finding responses, e.g. "needs clarification" (ARD §9). */
  responses?: Array<{ annotationId: string; note: string }>;
}

/**
 * `submit version` — non-first method. Stacks v(n+1) onto a request that is
 * awaiting a version (rejected or reopened).
 * Idempotency: an identical resubmission (same content hash for the expected
 * next version) is a no-op; a different content for an already-stacked
 * version number is a 409.
 */
export async function submitVersion(db: Db, input: SubmitVersionInput) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(reviewRequests)
      .where(
        and(
          eq(reviewRequests.projectId, input.projectId),
          eq(reviewRequests.customerRequestId, input.customerRequestId)
        )
      )
      .for('update');

    if (!request)
      throw new ApiProblem(
        404,
        'request_not_found',
        'Unknown request id — submit version never implicitly creates (two-method contract)'
      );

    // Idempotency first: a crashed-and-retried consumer resends the content
    // that already landed as the latest version — no-op regardless of the
    // status the request has since moved to (ARD §9). Compare bodies, not
    // commitments: each version has its own key, so the same text does not
    // produce the same digest.
    const latest = await tx.query.artifactVersions.findFirst({
      where: eq(artifactVersions.requestId, request.id),
      orderBy: (v, { desc }) => [desc(v.versionNumber)],
    });
    if (latest && latest.contentMd === input.contentMd && latest.versionNumber === request.round) {
      return { request, version: latest, created: false as const, classifications: null };
    }

    if (request.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');
    if (request.status === 'accepted')
      throw new ApiProblem(409, 'already_accepted', 'Request is accepted — terminal for this round');
    if (!isAwaitingVersion(request.status))
      throw new ApiProblem(
        409,
        'not_awaiting_version',
        `Request status is ${request.status}; a new version can only follow a rejection or a reopen`
      );

    const queue = await tx.query.queues.findFirst({ where: eq(queues.id, request.queueId) });
    if (!queue) throw new ApiProblem(500, 'queue_not_found', 'Queue missing for request');
    assertModalityMatch(queue.modality, artifactModalityOf(input));

    const nextNumber = request.round + 1;

    const dupe = await tx.query.artifactVersions.findFirst({
      where: and(
        eq(artifactVersions.requestId, request.id),
        eq(artifactVersions.versionNumber, nextNumber)
      ),
    });
    if (dupe) {
      if (dupe.contentMd === input.contentMd) {
        return { request, version: dupe, created: false as const, classifications: null };
      }
      throw new ApiProblem(
        409,
        'idempotency_conflict',
        `Version ${nextNumber} already exists with different content`
      );
    }

    const prevVersion = await tx.query.artifactVersions.findFirst({
      where: and(
        eq(artifactVersions.requestId, request.id),
        eq(artifactVersions.versionNumber, request.round)
      ),
    });
    if (!prevVersion) throw new ApiProblem(500, 'version_missing', 'Previous version missing');

    const version = await insertCommittedVersion(tx, {
      requestId: request.id,
      versionNumber: nextNumber,
      authorKind: 'model',
      authorLabel: input.authorLabel ?? 'model run',
      contentMd: input.contentMd,
    });
    const hash = version.contentHash;

    const oversized = input.contentMd.length > SYNC_CLASSIFY_LIMIT;
    const counters = await classifyLiveOntoVersion(tx, {
      requestId: request.id,
      prevContentMd: prevVersion.contentMd,
      nextContentMd: input.contentMd,
      nextVersionId: version.id,
    });

    if (input.responses?.length) {
      await tx.insert(versionResponses).values(
        input.responses.map((r) => ({
          versionId: version.id,
          annotationId: r.annotationId,
          note: r.note,
        }))
      );
    }

    await tx
      .update(reviewRequests)
      .set({ status: 'open', round: nextNumber, updatedAt: new Date() })
      .where(eq(reviewRequests.id, request.id));

    await appendEvent(tx, request.id, 'version.submitted', {
      version: nextNumber,
      content_hash: hash,
      author: version.authorLabel,
      responses: input.responses ?? [],
    });
    await enqueueJudgeRun(tx, {
      requestId: request.id,
      versionId: version.id,
      versionNumber: nextNumber,
    });
    await appendEvent(tx, request.id, 'anchors.classified', {
      version: nextNumber,
      deferred: oversized,
      ...counters,
    });
    if (counters.persisting > 0) {
      await appendEvent(tx, request.id, 'correction.persisting', {
        version: nextNumber,
        count: counters.persisting,
      });
    }

    try {
      await getStorage().putContent(input.contentMd, 'artifacts');
    } catch (err) {
      console.warn('artifact mirror write failed (non-fatal):', err);
    }

    const updated = await tx.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, request.id),
    });
    return { request: updated!, version, created: true as const, classifications: counters };
  });
}

export interface LateFinding {
  severity: 'critical' | 'minor';
  id?: string;
  criterion?: string;
  note?: string;
  evidence?: string;
  producer?: string;
}

/**
 * Late-critical reopen (ARD §38.4). Transitions accepted → reopened.
 * The original decision.accepted event stands. The new event carries
 * already_shipped so a consumer can branch. No new review_requests row —
 * a reopen is a round inside the same billable unit (§25.1.2).
 *
 * The judge does not run in this tree; tests and a future producer call this.
 */
export async function reopenByLateFinding(
  db: Db,
  input: { requestId: string; finding: LateFinding }
) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, input.requestId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (locked.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');
    if (locked.status === 'reopened') {
      return { request: locked, created: false as const };
    }
    if (locked.status !== 'accepted') {
      throw new ApiProblem(
        409,
        'not_accepted',
        `Request status is ${locked.status}; only an accepted request can reopen`
      );
    }
    if (input.finding.severity !== 'critical') {
      throw new ApiProblem(
        422,
        'not_critical',
        'Only a critical late finding reopens an acceptance'
      );
    }

    await tx
      .update(reviewRequests)
      .set({ status: 'reopened', updatedAt: new Date() })
      .where(eq(reviewRequests.id, locked.id));

    await appendEvent(tx, locked.id, REOPEN_EVENT_TYPE, {
      already_shipped: true,
      finding: input.finding,
      from_status: 'accepted',
      accepted_hash: locked.acceptedHash,
      round: locked.round,
    });

    const updated = await tx.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, locked.id),
    });
    return { request: updated!, created: true as const };
  });
}
