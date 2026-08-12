import { and, eq, sql } from 'drizzle-orm';
import {
  reviewRequests,
  artifactVersions,
  annotations,
  anchorStates,
  requestTags,
  queues,
  policyVersions,
  versionResponses,
} from '@/lib/db/schema';
import { contentHash } from './events';
import { appendEvent, DbOrTx, Db } from './eventlog';
import { classify, applyConfirmation } from '@/lib/anchoring/classify';
import { parsePolicyConfig, PolicyConfig } from './policy';
import { getStorage } from '@/lib/storage';

export class ApiProblem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Artifacts above this size classify asynchronously (decision 2A guard). */
export const SYNC_CLASSIFY_LIMIT = 500 * 1024;

export interface CreateReviewInput {
  projectId: string;
  queueSlug: string;
  environment?: 'production' | 'test';
  customerRequestId: string;
  title: string;
  contentMd: string;
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

    const queue = await tx.query.queues.findFirst({
      where: and(
        eq(queues.projectId, input.projectId),
        eq(queues.slug, input.queueSlug),
        eq(queues.environment, input.environment ?? 'production')
      ),
    });
    if (!queue) throw new ApiProblem(404, 'queue_not_found', `Queue ${input.queueSlug} (${input.environment ?? 'production'}) not found in project`);
    if (!queue.openForReview) throw new ApiProblem(409, 'queue_closed', 'Queue is not open for review');
    if (!queue.activePolicyVersionId)
      throw new ApiProblem(500, 'queue_unconfigured', 'Queue has no active policy version');

    const policy = await getPolicyForRequest(tx, queue.activePolicyVersionId);
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

    const hash = contentHash(input.contentMd);
    const [version] = await tx
      .insert(artifactVersions)
      .values({
        requestId: request.id,
        versionNumber: 1,
        authorKind: 'model',
        authorLabel: input.authorLabel ?? 'model run',
        contentMd: input.contentMd,
        contentHash: hash,
      })
      .returning();

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
      policy_version_id: request.policyVersionId,
      title: request.title,
    });
    await appendEvent(tx, request.id, 'version.submitted', {
      version: 1,
      content_hash: hash,
      author: version.authorLabel,
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
  authorLabel?: string;
  /** Per-finding responses, e.g. "needs clarification" (ARD §9). */
  responses?: Array<{ annotationId: string; note: string }>;
}

/**
 * `submit version` — non-first method. Stacks v(n+1) onto a rejected request.
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

    const hash = contentHash(input.contentMd);

    // Idempotency first: a crashed-and-retried consumer resends the content
    // that already landed as the latest version — no-op regardless of the
    // status the request has since moved to (ARD §9).
    const latest = await tx.query.artifactVersions.findFirst({
      where: eq(artifactVersions.requestId, request.id),
      orderBy: (v, { desc }) => [desc(v.versionNumber)],
    });
    if (latest && latest.contentHash === hash && latest.versionNumber === request.round) {
      return { request, version: latest, created: false as const, classifications: null };
    }

    if (request.status === 'accepted')
      throw new ApiProblem(409, 'already_accepted', 'Request is accepted — terminal');
    if (request.status !== 'rejected')
      throw new ApiProblem(
        409,
        'not_awaiting_version',
        `Request status is ${request.status}; a new version can only follow a rejection`
      );

    const nextNumber = request.round + 1;

    const dupe = await tx.query.artifactVersions.findFirst({
      where: and(
        eq(artifactVersions.requestId, request.id),
        eq(artifactVersions.versionNumber, nextNumber)
      ),
    });
    if (dupe) {
      if (dupe.contentHash === hash) {
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

    const [version] = await tx
      .insert(artifactVersions)
      .values({
        requestId: request.id,
        versionNumber: nextNumber,
        authorKind: 'model',
        authorLabel: input.authorLabel ?? 'model run',
        contentMd: input.contentMd,
        contentHash: hash,
      })
      .returning();

    // Re-anchor every live annotation (decision 2A: sync under the guard).
    const live = await tx
      .select()
      .from(annotations)
      .where(and(eq(annotations.requestId, request.id), sql`${annotations.retiredAt} is null`));

    const counters = { resolved: 0, persisting: 0, orphaned: 0 };
    const oversized = input.contentMd.length > SYNC_CLASSIFY_LIMIT;

    if (!oversized) {
      for (const ann of live) {
        const computed = applyConfirmation(
          classify(
            {
              quote: ann.quote,
              prefix: ann.prefix,
              suffix: ann.suffix,
              startPos: ann.startPos,
              endPos: ann.endPos,
            },
            prevVersion.contentMd,
            input.contentMd
          ),
          null
        );
        counters[computed.state] += 1;

        await tx
          .insert(anchorStates)
          .values({
            annotationId: ann.id,
            versionId: version.id,
            state: computed.state,
            confidence: computed.confidence,
            newQuote: computed.landing?.quote ?? null,
            newStartPos: computed.landing?.start ?? null,
            newEndPos: computed.landing?.end ?? null,
          })
          .onConflictDoNothing();

        // Persisting anchors carry the annotation forward: its selector now
        // points at the landing on the new version (history in anchor_states).
        if (computed.state === 'persisting' && computed.landing) {
          const p = input.contentMd;
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
    }

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
