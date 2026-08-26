import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { reviewRequests, artifactVersions } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { authenticateProducerKey } from '@/lib/findings/producers';
import { countRecentProducerPosts, ingestFindings } from '@/lib/findings/ingest';
import { readFindings } from '@/lib/findings/read';
import { ApiProblem } from '@/lib/core/requests';

/**
 * POST /api/v1/findings  — producer ingest (Bearer producer key)
 * GET  /api/v1/findings?request_id=&version=  — pipeline or producer read
 *
 * Ids travel in the body/query, never the path (same as /reviews).
 */

const findingSchema = z.object({
  criterion: z.string().min(1).max(64),
  passed: z.boolean().optional(),
  severity: z.enum(['critical', 'minor']).optional(),
  selector: z.object({
    quote: z.string().min(1),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    start: z.number().int().optional(),
    end: z.number().int().optional(),
  }),
  structuralAddress: z
    .object({
      container: z.string().min(1),
      blockId: z.string().min(1),
      ordinal: z.number().int().optional(),
    })
    .optional(),
  evidence: z.string().min(1),
  note: z.string().min(1),
});

const postSchema = z.object({
  request_id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  version_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(1).max(128),
  findings: z.array(findingSchema).min(1).max(50),
});

async function bearerToken(req: Request): Promise<string> {
  const header = req.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function POST(req: Request) {
  try {
    const token = await bearerToken(req);
    const producer = await authenticateProducerKey(db, token);
    if (producer.muted)
      throw new ApiProblem(403, 'producer_muted', 'Producer is muted');

    const body = postSchema.parse(await req.json());
    const since = new Date(Date.now() - 60_000);
    const recent = await countRecentProducerPosts(db, producer.producerId, since);
    if (recent + body.findings.length > producer.rateLimitPerMinute) {
      return Response.json(
        { error: 'rate_limited', message: 'Producer rate limit exceeded' },
        { status: 429, headers: { 'retry-after': '60' } }
      );
    }

    const request = await db.query.reviewRequests.findFirst({
      where: and(
        eq(reviewRequests.projectId, producer.projectId),
        eq(reviewRequests.customerRequestId, body.request_id)
      ),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found in this project');

    let versionId = body.version_id;
    if (!versionId) {
      const version = await db.query.artifactVersions.findFirst({
        where: and(
          eq(artifactVersions.requestId, request.id),
          eq(artifactVersions.versionNumber, body.version ?? request.round)
        ),
      });
      if (!version) throw new ApiProblem(404, 'version_not_found', 'Version not found');
      versionId = version.id;
    }

    const result = await ingestFindings(db, {
      requestId: request.id,
      versionId,
      producerId: producer.producerId,
      idempotencyKey: body.idempotency_key,
      findings: body.findings.map((f) => ({
        ...f,
        passed: f.passed,
      })),
    });

    return Response.json(
      {
        ids: result.ids,
        replayed: result.replayed,
        findings: result.findings.map((f) => ({
          id: f.id,
          criterion: f.criterionKey,
          triage: f.triage,
          start: f.startPos,
          end: f.endPos,
          structuralAddress:
            f.structuralContainer && f.structuralBlockId
              ? {
                  container: f.structuralContainer,
                  blockId: f.structuralBlockId,
                  ordinal: f.structuralOrdinal,
                }
              : undefined,
        })),
      },
      { status: result.replayed ? 200 : 201 }
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
    const requestId = url.searchParams.get('request_id');
    if (!requestId) {
      return Response.json({ error: 'invalid_query', message: 'request_id required' }, { status: 422 });
    }
    const request = await db.query.reviewRequests.findFirst({
      where: and(
        eq(reviewRequests.projectId, principal.projectId),
        eq(reviewRequests.customerRequestId, requestId)
      ),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    const versionNumber = url.searchParams.get('version');
    const version = await db.query.artifactVersions.findFirst({
      where: and(
        eq(artifactVersions.requestId, request.id),
        eq(artifactVersions.versionNumber, versionNumber ? Number(versionNumber) : request.round)
      ),
    });
    if (!version) throw new ApiProblem(404, 'version_not_found', 'Version not found');

    const audience = url.searchParams.get('audience') === 'admin' ? 'admin' : 'reviewer';
    const read = await readFindings(db, {
      requestId: request.id,
      versionId: version.id,
      audience,
    });
    return Response.json({
      withheld: read.withheld,
      run: read.run
        ? {
            id: read.run.id,
            state: read.run.state,
            overall_score: read.run.overallScore,
          }
        : null,
      findings: read.findings,
    });
  } catch (err) {
    return problemResponse(err);
  }
}
