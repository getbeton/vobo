import { createHash, randomBytes } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { findingProducers, producerKeys } from '@/lib/db/schema';
import { ApiProblem } from '@/lib/core/requests';
import { Db, DbOrTx } from '@/lib/core/eventlog';

export const BUILTIN_JUDGE_SLUG = 'vobo-judge';
export const BUILTIN_PII_SLUG = 'pii-regex';

export interface ProducerPrincipal {
  producerId: string;
  projectId: string;
  keyId: string;
  slug: string;
  muted: boolean;
  rateLimitPerMinute: number;
}

export async function authenticateProducerKey(
  db: Db,
  token: string
): Promise<ProducerPrincipal> {
  if (!token) throw new ApiProblem(401, 'missing_token', 'Authorization: Bearer <producer key> required');
  const keyHash = createHash('sha256').update(token).digest('hex');
  const key = await db.query.producerKeys.findFirst({ where: eq(producerKeys.keyHash, keyHash) });
  if (!key) throw new ApiProblem(401, 'invalid_token', 'Unknown or revoked producer key');
  if (key.revokedAt) {
    throw new ApiProblem(
      401,
      'revoked_token',
      `Producer key revoked at ${key.revokedAt.toISOString()}`
    );
  }
  const producer = await db.query.findingProducers.findFirst({
    where: eq(findingProducers.id, key.producerId),
  });
  if (!producer) throw new ApiProblem(401, 'invalid_token', 'Unknown or revoked producer key');

  db.update(producerKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(producerKeys.id, key.id))
    .then(() => {})
    .catch(() => {});

  return {
    producerId: producer.id,
    projectId: producer.projectId,
    keyId: key.id,
    slug: producer.slug,
    muted: Boolean(producer.mutedAt),
    rateLimitPerMinute: key.rateLimitPerMinute,
  };
}

export async function ensureBuiltinProducer(
  tx: DbOrTx,
  projectId: string,
  slug: typeof BUILTIN_JUDGE_SLUG | typeof BUILTIN_PII_SLUG,
  name: string
) {
  const existing = await tx.query.findingProducers.findFirst({
    where: and(eq(findingProducers.projectId, projectId), eq(findingProducers.slug, slug)),
  });
  if (existing) return existing;
  const [row] = await tx
    .insert(findingProducers)
    .values({ projectId, slug, name, builtin: true })
    .returning();
  return row;
}

export async function createProducer(
  db: Db,
  input: { projectId: string; name: string; slug: string; rateLimitPerMinute?: number }
) {
  const token = `vobo_pk_${randomBytes(24).toString('base64url')}`;
  return db.transaction(async (tx) => {
    const [producer] = await tx
      .insert(findingProducers)
      .values({
        projectId: input.projectId,
        name: input.name,
        slug: input.slug,
        builtin: false,
      })
      .returning();
    const [key] = await tx
      .insert(producerKeys)
      .values({
        producerId: producer.id,
        keyHash: createHash('sha256').update(token).digest('hex'),
        keyPrefix: token.slice(0, 12),
        rateLimitPerMinute: input.rateLimitPerMinute ?? 600,
      })
      .returning();
    return { producer, key, token };
  });
}

export async function mintProducerKey(
  db: Db,
  producerId: string,
  rateLimitPerMinute?: number
) {
  const token = `vobo_pk_${randomBytes(24).toString('base64url')}`;
  const [key] = await db
    .insert(producerKeys)
    .values({
      producerId,
      keyHash: createHash('sha256').update(token).digest('hex'),
      keyPrefix: token.slice(0, 12),
      rateLimitPerMinute: rateLimitPerMinute ?? 600,
    })
    .returning();
  return { key, token };
}

export async function revokeProducerKey(db: Db, keyId: string) {
  const [row] = await db
    .update(producerKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(producerKeys.id, keyId), isNull(producerKeys.revokedAt)))
    .returning();
  return row;
}

export async function setProducerMuted(db: Db, producerId: string, muted: boolean) {
  const [row] = await db
    .update(findingProducers)
    .set({ mutedAt: muted ? new Date() : null })
    .where(eq(findingProducers.id, producerId))
    .returning();
  return row;
}
