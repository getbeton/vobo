import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { reviewRequests, artifactVersions } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { ApiProblem } from '@/lib/core/requests';
import { getVerifiedChain } from '@/lib/core/eventlog';

/** GET /api/v1/review?request_id=… — full request state for a consumer. */
export async function GET(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const url = new URL(req.url);
    const customerRequestId = url.searchParams.get('request_id');
    if (!customerRequestId)
      throw new ApiProblem(422, 'request_id_required', 'request_id query param required');

    const request = await db.query.reviewRequests.findFirst({
      where: and(
        eq(reviewRequests.projectId, principal.projectId),
        eq(reviewRequests.customerRequestId, customerRequestId)
      ),
    });
    if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');

    const versions = await db
      .select({
        version: artifactVersions.versionNumber,
        author_kind: artifactVersions.authorKind,
        author_label: artifactVersions.authorLabel,
        content_hash: artifactVersions.contentHash,
        human_authored: artifactVersions.humanAuthored,
        created_at: artifactVersions.createdAt,
      })
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id))
      .orderBy(asc(artifactVersions.versionNumber));

    const { rows, verification } = await getVerifiedChain(db, request.id);

    return Response.json({
      request_id: request.customerRequestId,
      id: request.id,
      status: request.status,
      awaiting_version: request.status === 'rejected',
      round: request.round,
      title: request.title,
      accepted_hash: request.acceptedHash,
      archived_at: request.archivedAt,
      policy_version_id: request.policyVersionId,
      versions,
      chain: { ok: verification.ok, length: rows.length, broken_at: verification.brokenAtSeq ?? null },
      events: rows.map((r) => ({ seq: r.seq, type: r.type, at: r.createdAt })),
    });
  } catch (err) {
    return problemResponse(err);
  }
}
