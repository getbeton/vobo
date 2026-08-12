import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { apiKeys } from '@/lib/db/schema';
import { authenticateApiKey, problemResponse } from '@/lib/core/apiauth';

/**
 * Server-side pull cursor per API key (ARD §9): consumers keep zero local
 * state; any machine with the same credentials shares the position.
 * GET /api/v1/cursor · PUT /api/v1/cursor {cursor_event_id}
 */

export async function GET(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, principal.keyId) });
    return Response.json({ cursor_event_id: key?.cursorEventId ?? null });
  } catch (err) {
    return problemResponse(err);
  }
}

const putSchema = z.object({ cursor_event_id: z.number().int().nonnegative() });

export async function PUT(req: Request) {
  try {
    const principal = await authenticateApiKey(req);
    const body = putSchema.parse(await req.json());
    await db
      .update(apiKeys)
      .set({ cursorEventId: body.cursor_event_id })
      .where(eq(apiKeys.id, principal.keyId));
    return Response.json({ cursor_event_id: body.cursor_event_id });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: 'invalid_body', issues: err.issues }, { status: 422 });
    }
    return problemResponse(err);
  }
}
