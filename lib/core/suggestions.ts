import { and, asc, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  annotations,
  artifactVersions,
  decisions,
  manualEdits,
  reviewRequests,
} from '@/lib/db/schema';
import { appendEvent, Db, DbOrTx } from './eventlog';
import { ApiProblem } from './requests';
import { contentHash } from './events';
import { applyManualEdits, shiftMarks, type ManualEditOp } from './manual-edits';

async function lockRequest(tx: DbOrTx, requestId: string) {
  const [locked] = await tx
    .select()
    .from(reviewRequests)
    .where(eq(reviewRequests.id, requestId))
    .for('update');
  if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');
  if (locked.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');
  if (['accepted', 'escalated'].includes(locked.status))
    throw new ApiProblem(409, 'terminal_status', `Request is ${locked.status}`);
  return locked;
}

async function currentVersion(tx: DbOrTx, request: { id: string; round: number }) {
  const version = await tx.query.artifactVersions.findFirst({
    where: and(
      eq(artifactVersions.requestId, request.id),
      eq(artifactVersions.versionNumber, request.round)
    ),
  });
  if (!version) throw new ApiProblem(500, 'version_missing', 'Current version missing');
  return version;
}

export async function listEdits(tx: DbOrTx, requestId: string, baseVersionId: string) {
  return tx
    .select()
    .from(manualEdits)
    .where(and(eq(manualEdits.requestId, requestId), eq(manualEdits.baseVersionId, baseVersionId)))
    .orderBy(asc(manualEdits.createdAt));
}

export async function workingContentMd(
  tx: DbOrTx,
  requestId: string,
  version: { id: string; contentMd: string }
) {
  const rows = await listEdits(tx, requestId, version.id);
  return applyManualEdits(version.contentMd, rows as ManualEditOp[]);
}

export async function createSuggestion(
  db: Db,
  input: {
    requestId: string;
    userId: string;
    startPos: number;
    endPos: number;
    replacement: string;
  }
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, input.requestId);
    const version = await currentVersion(tx, request);
    const working = await workingContentMd(tx, request.id, version);
    if (
      input.startPos < 0 ||
      input.endPos > working.length ||
      input.startPos >= input.endPos
    )
      throw new ApiProblem(422, 'invalid_range', 'Selection range is outside the artifact');
    const replacement = input.replacement;
    const originalQuote = working.slice(input.startPos, input.endPos);
    const [row] = await tx
      .insert(manualEdits)
      .values({
        requestId: request.id,
        baseVersionId: version.id,
        startPos: input.startPos,
        endPos: input.endPos,
        originalQuote,
        replacement,
        status: 'pending',
        createdBy: input.userId,
      })
      .returning();
    await appendEvent(tx, request.id, 'suggestion.created', {
      suggestion_id: row.id,
      by: input.userId,
    });
    return row;
  });
}

export async function acceptSuggestion(
  db: Db,
  input: { requestId: string; suggestionId: string; userId: string }
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, input.requestId);
    const version = await currentVersion(tx, request);
    const [row] = await tx
      .select()
      .from(manualEdits)
      .where(and(eq(manualEdits.id, input.suggestionId), eq(manualEdits.requestId, request.id)))
      .for('update');
    if (!row) throw new ApiProblem(404, 'suggestion_not_found', 'Suggestion not found');
    if (row.status !== 'pending')
      throw new ApiProblem(409, 'suggestion_not_pending', 'Suggestion is not pending');
    if (row.baseVersionId !== version.id)
      throw new ApiProblem(409, 'stale_suggestion', 'Suggestion is not on the current version');

    const now = new Date();
    await tx
      .update(manualEdits)
      .set({ status: 'applied', decidedAt: now })
      .where(eq(manualEdits.id, row.id));

    const others = await tx
      .select()
      .from(manualEdits)
      .where(
        and(
          eq(manualEdits.requestId, request.id),
          eq(manualEdits.baseVersionId, version.id),
          inArray(manualEdits.status, ['pending', 'applied']),
          ne(manualEdits.id, row.id)
        )
      );
    const shifted = shiftMarks(
      others.map((o) => ({ id: o.id, startPos: o.startPos, endPos: o.endPos, status: o.status })),
      { startPos: row.startPos, endPos: row.endPos, replacement: row.replacement }
    );
    for (const o of shifted.orphaned) {
      if (o.status === 'pending') {
        await tx
          .update(manualEdits)
          .set({ status: 'rejected', decidedAt: now })
          .where(eq(manualEdits.id, o.id));
      }
    }
    for (const o of shifted.kept) {
      const src = others.find((x) => x.id === o.id);
      if (!src) continue;
      if (src.startPos !== o.startPos || src.endPos !== o.endPos) {
        await tx
          .update(manualEdits)
          .set({ startPos: o.startPos, endPos: o.endPos })
          .where(eq(manualEdits.id, o.id));
      }
    }

    const live = await tx
      .select()
      .from(annotations)
      .where(and(eq(annotations.requestId, request.id), isNull(annotations.retiredAt)));
    const commentShift = shiftMarks(
      live.map((a) => ({ id: a.id, startPos: a.startPos, endPos: a.endPos })),
      { startPos: row.startPos, endPos: row.endPos, replacement: row.replacement }
    );
    for (const o of commentShift.orphaned) {
      await tx
        .update(annotations)
        .set({
          retiredAt: now,
          retireReason: 'overlapped by a suggestion',
        })
        .where(eq(annotations.id, o.id));
    }
    for (const k of commentShift.kept) {
      const src = live.find((a) => a.id === k.id);
      if (!src) continue;
      if (src.startPos !== k.startPos || src.endPos !== k.endPos) {
        const working = applyManualEdits(version.contentMd, [
          ...(await listEdits(tx, request.id, version.id)),
        ] as ManualEditOp[]);
        await tx
          .update(annotations)
          .set({
            startPos: k.startPos,
            endPos: k.endPos,
            quote: working.slice(k.startPos, k.endPos),
            prefix: working.slice(Math.max(0, k.startPos - 32), k.startPos),
            suffix: working.slice(k.endPos, k.endPos + 32),
          })
          .where(eq(annotations.id, k.id));
      }
    }

    await appendEvent(tx, request.id, 'suggestion.applied', {
      suggestion_id: row.id,
      by: input.userId,
    });
  });
}

export async function rejectSuggestion(
  db: Db,
  input: { requestId: string; suggestionId: string; userId: string }
) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, input.requestId);
    const [row] = await tx
      .select()
      .from(manualEdits)
      .where(and(eq(manualEdits.id, input.suggestionId), eq(manualEdits.requestId, request.id)))
      .for('update');
    if (!row) throw new ApiProblem(404, 'suggestion_not_found', 'Suggestion not found');
    if (row.status !== 'pending')
      throw new ApiProblem(409, 'suggestion_not_pending', 'Suggestion is not pending');
    await tx
      .update(manualEdits)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(eq(manualEdits.id, row.id));
    await appendEvent(tx, request.id, 'suggestion.rejected', {
      suggestion_id: row.id,
      by: input.userId,
    });
  });
}

export async function saveManualEdits(db: Db, input: { requestId: string; userId: string }) {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, input.requestId);
    const version = await currentVersion(tx, request);
    const rows = await listEdits(tx, request.id, version.id);
    if (rows.some((r) => r.status === 'pending'))
      throw new ApiProblem(
        422,
        'pending_suggestions',
        'Accept or reject open suggestions first'
      );
    const applied = rows.filter((r) => r.status === 'applied');
    if (applied.length === 0)
      throw new ApiProblem(422, 'no_applied_edits', 'No accepted suggestions to save');
    const content = applyManualEdits(version.contentMd, rows as ManualEditOp[]);
    if (!content.trim())
      throw new ApiProblem(422, 'empty_artifact', 'Edited artifact is empty');
    const nextNumber = request.round + 1;
    const hash = contentHash(content);
    const [human] = await tx
      .insert(artifactVersions)
      .values({
        requestId: request.id,
        versionNumber: nextNumber,
        authorKind: 'human',
        authorLabel: 'human edit',
        contentMd: content,
        contentHash: hash,
        humanAuthored: true,
      })
      .returning();
    await tx
      .update(reviewRequests)
      .set({ round: nextNumber, updatedAt: new Date() })
      .where(eq(reviewRequests.id, request.id));
    await tx
      .update(annotations)
      .set({ bornRound: nextNumber })
      .where(
        and(
          eq(annotations.requestId, request.id),
          eq(annotations.bornRound, request.round),
          isNull(annotations.retiredAt)
        )
      );
    await appendEvent(tx, request.id, 'version.human_saved', {
      version: nextNumber,
      content_hash: hash,
      applied_count: applied.length,
      by: input.userId,
    });
    return { version: human, round: nextNumber };
  });
}

/** Reject wall: count reject decisions, not version numbers. */
export async function rejectDecisionCount(tx: DbOrTx, requestId: string) {
  const [row] = await tx
    .select({ n: count() })
    .from(decisions)
    .where(
      and(
        eq(decisions.requestId, requestId),
        inArray(decisions.kind, ['reject_corrections', 'reject_rerun'])
      )
    );
  return Number(row?.n ?? 0);
}
