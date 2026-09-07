import { eq, inArray } from 'drizzle-orm';
import {
  annotations,
  artifactVersions,
  reviewRequests,
} from '@/lib/db/schema';
import { appendEvent, Db, DbOrTx } from './eventlog';
import { ApiProblem } from './requests';
import { EXPIRY_EVENT } from './events';

export { EXPIRY_EVENT };

function expiryTombstone(at: Date): string {
  return `[Content expired ${at.toISOString()} · retention]`;
}

/**
 * Routine retention expiry: purge artifact bodies and comment text, keep
 * every materialised commitment key. The workspace root is not involved.
 * Must not be used for GDPR/customer erasure — that lives in erasure.ts.
 */
export async function expireRequestContent(db: Db, requestId: string) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, requestId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');

    const versions = await tx
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, requestId));

    const pending = versions.filter((v) => v.contentPurgedAt === null);
    if (pending.length === 0) {
      return { purged: [] as string[], alreadyExpired: true as const };
    }

    const at = new Date();
    const tombstone = expiryTombstone(at);
    const purgedIds: string[] = [];

    for (const version of pending) {
      await tx
        .update(artifactVersions)
        .set({
          contentMd: tombstone,
          contentPurgedAt: at,
        })
        .where(eq(artifactVersions.id, version.id));
      purgedIds.push(version.id);
    }

    await tx
      .update(reviewRequests)
      .set({
        prompt: locked.prompt ? tombstone : locked.prompt,
        source: locked.source ? tombstone : locked.source,
        updatedAt: at,
      })
      .where(eq(reviewRequests.id, requestId));

    if (purgedIds.length > 0) {
      await tx
        .update(annotations)
        .set({
          body: tombstone,
          expected: tombstone,
          quote: tombstone,
          prefix: '',
          suffix: '',
        })
        .where(
          inArray(annotations.bornVersionId, purgedIds)
        );
    }

    await appendEvent(tx as DbOrTx, requestId, EXPIRY_EVENT, {
      request_id: requestId,
      artifact_version_ids: purgedIds,
      expired_at: at.toISOString(),
    });

    return { purged: purgedIds, alreadyExpired: false as const };
  });
}
