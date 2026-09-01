import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { submitVersion } from '@/lib/core/requests';

/** POST /api/v1/versions — `submit version` (non-first generation). */

const schema = z.object({
  request_id: z.string().min(1).max(255),
  content_md: z.string().min(1),
  modality: z.enum(['text', 'code', 'table', 'image']).optional(),
  author_label: z.string().max(200).optional(),
  responses: z
    .array(z.object({ annotation_id: z.string().uuid(), note: z.string().min(1) }))
    .optional(),
});

export async function POST(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const body = schema.parse(await req.json());
    const result = await submitVersion(db, {
      projectId: principal.projectId,
      customerRequestId: body.request_id,
      contentMd: body.content_md,
      modality: body.modality,
      authorLabel: body.author_label,
      responses: body.responses?.map((r) => ({ annotationId: r.annotation_id, note: r.note })),
    });
    return Response.json(
      {
        request_id: result.request.customerRequestId,
        status: result.request.status,
        round: result.request.round,
        version: result.version.versionNumber,
        content_hash: result.version.contentHash,
        created: result.created,
        classifications: result.classifications,
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
