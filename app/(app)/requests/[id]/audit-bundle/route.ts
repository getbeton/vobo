import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import { reviewRequests } from '@/lib/db/schema';
import { workspaceOfRequestOrNull, canReview } from '@/lib/core/authz';
import { buildRequestAuditBundle } from '@/lib/core/audit-export';

export const dynamic = 'force-dynamic';

/** GET /requests/:id/audit-bundle — JSON evidence pack. Workspace root omitted. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const request = await db.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, id),
  });
  if (!request) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const wsId = await workspaceOfRequestOrNull(request.id);
  if (wsId === null || !(await canReview(user.id, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const bundle = await buildRequestAuditBundle(db, request.id);
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="vobo-audit-${request.id}.json"`,
    },
  });
}
