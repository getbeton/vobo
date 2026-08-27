import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { projects } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { listJudgeRecords } from '@/lib/judge/records';

/** GET /api/v1/judge-records?after=  — append-only per-workspace judge log. */
export async function GET(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, principal.projectId),
    });
    if (!project) {
      return Response.json({ error: 'project_not_found', message: 'Project not found' }, { status: 404 });
    }
    const url = new URL(req.url);
    const after = url.searchParams.get('after');
    const rows = await listJudgeRecords(db, {
      workspaceId: project.workspaceId,
      afterId: after ? Number(after) : undefined,
    });
    return Response.json({
      records: rows.map((r) => ({
        id: r.id,
        request_id: r.requestId,
        version_id: r.versionId,
        run_id: r.runId,
        payload: r.payload,
        created_at: r.createdAt,
      })),
    });
  } catch (err) {
    return problemResponse(err);
  }
}
