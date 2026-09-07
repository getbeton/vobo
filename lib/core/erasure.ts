import { and, eq, inArray } from 'drizzle-orm';
import {
  annotations,
  artifactVersions,
  reviewRequests,
} from '@/lib/db/schema';
import { appendEvent, Db, DbOrTx } from './eventlog';
import { ApiProblem } from './requests';
import { ERASURE_EVENT } from './events';

export { ERASURE_EVENT };

export interface EraseScopeInput {
  requestId: string;
  /** Defaults to every version on the request. */
  artifactVersionIds?: string[];
  /** External authorising request (GDPR / customer erasure). */
  authorizingRequestId: string;
  userId: string;
}

function erasureTombstone(at: Date, authorizingRequestId: string): string {
  return `[Content erased ${at.toISOString()} · authorised by ${authorizingRequestId}]`;
}

/**
 * Explicit erasure: purge bodies in the scope and destroy only that scope's
 * materialised commitment keys. Does not touch the workspace root. Must not
 * be used for routine retention — that lives in expiry.ts.
 */
export async function eraseScope(db: Db, input: EraseScopeInput) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, input.requestId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');

    const allVersions = await tx
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, input.requestId));

    const wanted = input.artifactVersionIds
      ? new Set(input.artifactVersionIds)
      : null;
    const targets = wanted
      ? allVersions.filter((v) => wanted.has(v.id))
      : allVersions;
    if (wanted && targets.length !== wanted.size) {
      throw new ApiProblem(404, 'version_not_found', 'Artifact version not on this request');
    }

    const stillKeyed = targets.filter((v) => v.commitmentKey !== null);
    const at = new Date();
    const tombstone = erasureTombstone(at, input.authorizingRequestId);
    const destroyedIds: string[] = [];

    for (const version of stillKeyed) {
      await tx
        .update(artifactVersions)
        .set({
          contentMd: tombstone,
          contentPurgedAt: version.contentPurgedAt ?? at,
          commitmentKey: null,
          keyDestroyedAt: at,
        })
        .where(eq(artifactVersions.id, version.id));
      destroyedIds.push(version.id);
    }

    // Bodies already erased (retry): still record nothing new.
    if (destroyedIds.length === 0) {
      return { destroyed: [] as string[], alreadyErased: true as const };
    }

    const requestWide = !wanted || wanted.size === allVersions.length;
    if (requestWide) {
      await tx
        .update(reviewRequests)
        .set({
          prompt: locked.prompt ? tombstone : locked.prompt,
          source: locked.source ? tombstone : locked.source,
          updatedAt: at,
        })
        .where(eq(reviewRequests.id, input.requestId));
    }

    const bornOn = targets.map((v) => v.id);
    if (bornOn.length > 0) {
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
          and(
            eq(annotations.requestId, input.requestId),
            inArray(annotations.bornVersionId, bornOn)
          )
        );
    }

    await appendEvent(tx as DbOrTx, input.requestId, ERASURE_EVENT, {
      authorizing_request_id: input.authorizingRequestId,
      by: input.userId,
      scope: {
        request_id: input.requestId,
        artifact_version_ids: destroyedIds,
        request_wide: requestWide,
      },
      destroyed_at: at.toISOString(),
    });

    return { destroyed: destroyedIds, alreadyErased: false as const };
  });
}
