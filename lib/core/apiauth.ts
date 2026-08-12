import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { apiKeys } from '@/lib/db/schema';
import { ApiProblem } from './requests';

export interface ApiPrincipal {
  keyId: string;
  projectId: string;
}

/** Authenticate `Authorization: Bearer vobo_sk_…` → project-scoped principal. */
export async function authenticateApiKey(req: Request): Promise<ApiPrincipal> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new ApiProblem(401, 'missing_token', 'Authorization: Bearer <api key> required');

  const keyHash = createHash('sha256').update(token).digest('hex');
  const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.keyHash, keyHash) });
  if (!key || key.revokedAt) throw new ApiProblem(401, 'invalid_token', 'Unknown or revoked API key');

  // Fire-and-forget freshness stamp; never blocks the request.
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .then(() => {})
    .catch(() => {});

  return { keyId: key.id, projectId: key.projectId };
}

export function problemResponse(err: unknown): Response {
  if (err instanceof ApiProblem) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
  }
  console.error('unhandled api error:', err);
  return Response.json({ error: 'internal', message: 'Internal error' }, { status: 500 });
}
