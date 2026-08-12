import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { reviewRequests, criteria, criteriaVerdicts } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { ApiProblem } from '@/lib/core/requests';
import { outgoingCorrections } from '@/lib/core/verdict';

/**
 * GET /api/v1/corrections?request_id=… — everything a regeneration needs:
 * anchored corrections (with Expected outcomes), criteria fails, round.
 */
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

    const corrections = await outgoingCorrections(db, request.id);

    const fails = await db
      .select({ key: criteria.key, title: criteria.title, verdict: criteriaVerdicts.verdict })
      .from(criteriaVerdicts)
      .innerJoin(criteria, eq(criteria.id, criteriaVerdicts.criterionId))
      .where(eq(criteriaVerdicts.requestId, request.id));

    return Response.json({
      request_id: request.customerRequestId,
      status: request.status,
      round: request.round,
      corrections,
      criteria: fails,
    });
  } catch (err) {
    return problemResponse(err);
  }
}
