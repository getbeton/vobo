import { z } from 'zod';
import { and, eq, gt, inArray, isNull, max, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { reviewRequests, queues, events } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { createReview } from '@/lib/core/requests';
import {
  alreadyShipped,
  AWAITING_VERSION_STATUSES,
  isAwaitingVersion,
} from '@/lib/core/pull-contract';

/**
 * Flat pipeline API (customer request ids contain slashes, so ids travel in
 * bodies/query params, never in path segments — deviation from the ARD's
 * illustrative paths, same contract).
 *
 * POST /api/v1/reviews          — create review (first generation; idempotent)
 * GET  /api/v1/reviews          — pull: ?queue=&environment=&status=&
 *                                 awaiting_version=true&changed_since=<eventId>
 */

const createSchema = z.object({
  template: z.string().min(1).optional(),
  queue: z.string().min(1).optional(),
  environment: z.enum(['production', 'test']).optional(),
  request_id: z.string().min(1).max(255),
  title: z.string().min(1).max(300),
  content_md: z.string().min(1),
  modality: z.enum(['text', 'code', 'table', 'image']).optional(),
  prompt: z.string().optional(),
  source: z.string().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  author_label: z.string().max(200).optional(),
  pipeline_run_id: z.string().max(255).optional(),
  trace_id: z.string().max(255).optional(),
  tags: z.array(z.string().max(100)).optional(),
});

export async function POST(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const body = createSchema.parse(await req.json());
    const result = await createReview(db, {
      projectId: principal.projectId,
      templateSlug: body.template,
      queueSlug: body.queue,
      environment: body.environment,
      customerRequestId: body.request_id,
      title: body.title,
      contentMd: body.content_md,
      modality: body.modality,
      prompt: body.prompt,
      source: body.source,
      priority: body.priority,
      authorLabel: body.author_label,
      pipelineRunId: body.pipeline_run_id,
      traceId: body.trace_id,
      tags: body.tags,
    });
    return Response.json(
      {
        request_id: result.request.customerRequestId,
        id: result.request.id,
        status: result.request.status,
        round: result.request.round,
        created: result.created,
      },
      { status: result.created ? 201 : 200 }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: 'invalid_body', issues: err.issues }, { status: 422 });
    }
    return problemResponse(err);
  }
}

export async function GET(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const url = new URL(req.url);
    const queueSlug = url.searchParams.get('queue');
    const environment = url.searchParams.get('environment') ?? 'production';
    const status = url.searchParams.get('status');
    const awaiting = url.searchParams.get('awaiting_version') === 'true';
    const changedSince = url.searchParams.get('changed_since');

    // The work list hides archived rows so a pipeline does not wait on a
    // verdict that will never come. A changed_since delta includes them with
    // archived_at set, otherwise their request.archived events stall the cursor.
    const conditions = [eq(reviewRequests.projectId, principal.projectId)] as any[];
    if (!changedSince) conditions.push(isNull(reviewRequests.archivedAt));
    if (queueSlug) {
      const queue = await db.query.queues.findFirst({
        where: and(
          eq(queues.projectId, principal.projectId),
          eq(queues.slug, queueSlug),
          eq(queues.environment, environment as 'production' | 'test')
        ),
      });
      if (!queue) return Response.json({ reviews: [], max_event_id: null });
      conditions.push(eq(reviewRequests.queueId, queue.id));
    }
    if (awaiting) {
      conditions.push(inArray(reviewRequests.status, [...AWAITING_VERSION_STATUSES]));
    } else if (status) {
      conditions.push(
        inArray(
          reviewRequests.status,
          status.split(',') as Array<typeof reviewRequests.$inferSelect.status>
        )
      );
    }

    // changed_since is an event-id cursor: return requests with any newer event.
    const lastEvent = db
      .select({
        requestId: events.requestId,
        maxEventId: max(events.id).as('max_event_id'),
      })
      .from(events)
      .groupBy(events.requestId)
      .as('last_event');

    const rows = await db
      .select({ request: reviewRequests, maxEventId: lastEvent.maxEventId })
      .from(reviewRequests)
      .innerJoin(lastEvent, eq(lastEvent.requestId, reviewRequests.id))
      .where(
        and(
          ...conditions,
          changedSince ? gt(lastEvent.maxEventId, Number(changedSince)) : sql`true`
        )
      )
      .orderBy(lastEvent.maxEventId)
      .limit(200);

    const batchMax = rows.length ? Math.max(...rows.map((r) => Number(r.maxEventId))) : null;
    return Response.json({
      reviews: rows.map(({ request }) => ({
        request_id: request.customerRequestId,
        id: request.id,
        status: request.status,
        awaiting_version: isAwaitingVersion(request.status),
        already_shipped: alreadyShipped(request.status),
        round: request.round,
        title: request.title,
        accepted_hash: request.acceptedHash,
        budget_exhausted_at: request.budgetExhaustedAt,
        archived_at: request.archivedAt,
        updated_at: request.updatedAt,
      })),
      max_event_id: batchMax,
    });
  } catch (err) {
    return problemResponse(err);
  }
}
