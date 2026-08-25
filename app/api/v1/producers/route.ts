import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { findingProducers, producerKeys, projects } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';
import { createProducer, revokeProducerKey, setProducerMuted } from '@/lib/findings/producers';
import { ApiProblem } from '@/lib/core/requests';

const createSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  rate_limit_per_minute: z.number().int().min(1).max(10000).optional(),
});

export async function GET(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const rows = await db
      .select()
      .from(findingProducers)
      .where(eq(findingProducers.projectId, principal.projectId));
    return Response.json({
      producers: rows.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        builtin: p.builtin,
        muted: Boolean(p.mutedAt),
      })),
    });
  } catch (err) {
    return problemResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const body = createSchema.parse(await req.json());
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, principal.projectId),
    });
    if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
    const { producer, token } = await createProducer(db, {
      projectId: principal.projectId,
      name: body.name,
      slug: body.slug,
      rateLimitPerMinute: body.rate_limit_per_minute,
    });
    return Response.json(
      {
        id: producer.id,
        slug: producer.slug,
        token,
        note: 'The token is shown once. Store it; there is no read path.',
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: 'invalid_body', issues: err.issues }, { status: 422 });
    }
    return problemResponse(err);
  }
}

const patchSchema = z.object({
  producer_id: z.string().uuid(),
  muted: z.boolean().optional(),
  revoke_key_id: z.string().uuid().optional(),
});

export async function PATCH(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const body = patchSchema.parse(await req.json());
    const producer = await db.query.findingProducers.findFirst({
      where: eq(findingProducers.id, body.producer_id),
    });
    if (!producer || producer.projectId !== principal.projectId)
      throw new ApiProblem(404, 'producer_not_found', 'Producer not found');
    if (typeof body.muted === 'boolean') await setProducerMuted(db, producer.id, body.muted);
    if (body.revoke_key_id) {
      const key = await db.query.producerKeys.findFirst({
        where: eq(producerKeys.id, body.revoke_key_id),
      });
      if (!key || key.producerId !== producer.id)
        throw new ApiProblem(404, 'key_not_found', 'Key not found');
      await revokeProducerKey(db, key.id);
    }
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: 'invalid_body', issues: err.issues }, { status: 422 });
    }
    return problemResponse(err);
  }
}
