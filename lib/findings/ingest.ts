import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  artifactVersions,
  dismissalMemory,
  findingBatches,
  machineFindings,
  reviewRequests,
} from '@/lib/db/schema';
import { ApiProblem } from '@/lib/core/requests';
import { appendEvent, Db, DbOrTx } from '@/lib/core/eventlog';
import { findingFingerprint, quoteContext } from './fingerprint';

export interface IncomingFinding {
  criterion: string;
  /** Judge boolean for this criterion. Default false (a defect). */
  passed?: boolean;
  /** 0–1 confidence that this criterion passed. */
  score?: number | null;
  severity?: 'critical' | 'minor';
  selector: {
    quote: string;
    prefix?: string;
    suffix?: string;
    start?: number;
    end?: number;
  };
  structuralAddress?: {
    container: string;
    blockId: string;
    ordinal?: number;
  };
  evidence: string;
  note: string;
}

export interface IngestInput {
  requestId: string;
  versionId: string;
  producerId: string;
  idempotencyKey: string;
  findings: IncomingFinding[];
  judgeRunId?: string;
}

function selectorResolves(
  content: string,
  selector: IncomingFinding['selector']
): { startPos: number; endPos: number; quote: string } | null {
  const quote = selector.quote;
  if (!quote) return null;
  if (
    typeof selector.start === 'number' &&
    typeof selector.end === 'number' &&
    selector.start >= 0 &&
    selector.end <= content.length &&
    content.slice(selector.start, selector.end) === quote
  ) {
    return { startPos: selector.start, endPos: selector.end, quote };
  }
  const idx = content.indexOf(quote);
  if (idx < 0) return null;
  return { startPos: idx, endPos: idx + quote.length, quote };
}

export async function ingestFindings(db: Db, input: IngestInput) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, input.requestId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (locked.status === 'accepted')
      throw new ApiProblem(409, 'already_accepted', 'Cannot post findings on an accepted request');

    const version = await tx.query.artifactVersions.findFirst({
      where: eq(artifactVersions.id, input.versionId),
    });
    if (!version || version.requestId !== locked.id)
      throw new ApiProblem(404, 'version_not_found', 'Version not found on this request');

    const existingBatch = await tx.query.findingBatches.findFirst({
      where: and(
        eq(findingBatches.versionId, input.versionId),
        eq(findingBatches.producerId, input.producerId),
        eq(findingBatches.idempotencyKey, input.idempotencyKey)
      ),
    });
    if (existingBatch) {
      const ids = (existingBatch.findingIds as string[]) ?? [];
      const rows = ids.length
        ? await tx.select().from(machineFindings).where(inArray(machineFindings.id, ids))
        : [];
      return { ids, findings: rows, replayed: true as const };
    }

    const resolved: Array<{
      incoming: IncomingFinding;
      startPos: number;
      endPos: number;
      quote: string;
      fingerprint: string;
    }> = [];
    for (let i = 0; i < input.findings.length; i++) {
      const incoming = input.findings[i];
      const hit = selectorResolves(version.contentMd, incoming.selector);
      if (!hit) {
        throw new ApiProblem(
          422,
          'unresolvable_selector',
          `Selector at index ${i} does not occur in the target version`
        );
      }
      resolved.push({
        incoming,
        ...hit,
        fingerprint: findingFingerprint(incoming.criterion, hit.quote),
      });
    }

    const memory = await tx
      .select()
      .from(dismissalMemory)
      .where(eq(dismissalMemory.requestId, locked.id));
    const suppressed = new Set(memory.map((m) => m.fingerprint));
    // Blind requests accumulate no suppression set (ARD §26).
    const applyMemory = !locked.judgeBlind;

    const inserted: Array<typeof machineFindings.$inferSelect> = [];
    for (const item of resolved) {
      const ctx = quoteContext(version.contentMd, item.startPos, item.endPos);
      const addr = item.incoming.structuralAddress;
      const triage =
        applyMemory && suppressed.has(item.fingerprint) ? 'suppressed' : 'untriaged';
      const [row] = await tx
        .insert(machineFindings)
        .values({
          requestId: locked.id,
          versionId: version.id,
          producerId: input.producerId,
          judgeRunId: input.judgeRunId ?? null,
          criterionKey: item.incoming.criterion,
          severity: item.incoming.severity ?? 'minor',
          quote: item.quote,
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          startPos: item.startPos,
          endPos: item.endPos,
          structuralContainer: addr?.container ?? null,
          structuralBlockId: addr?.blockId ?? null,
          structuralOrdinal: addr?.ordinal ?? null,
          evidence: item.incoming.evidence,
          note: item.incoming.note,
          fingerprint: item.fingerprint,
          passed: item.incoming.passed ?? false,
          score:
            typeof item.incoming.score === 'number' && Number.isFinite(item.incoming.score)
              ? Math.min(1, Math.max(0, item.incoming.score))
              : null,
          triage,
        })
        .returning();
      inserted.push(row);
    }

    await tx.insert(findingBatches).values({
      versionId: version.id,
      producerId: input.producerId,
      idempotencyKey: input.idempotencyKey,
      findingIds: inserted.map((r) => r.id),
    });

    await appendEvent(tx, locked.id, 'findings.ingested', {
      version_id: version.id,
      producer_id: input.producerId,
      count: inserted.length,
      suppressed: inserted.filter((r) => r.triage === 'suppressed').length,
      judge_run_id: input.judgeRunId ?? null,
    });

    return { ids: inserted.map((r) => r.id), findings: inserted, replayed: false as const };
  });
}

export async function countRecentProducerPosts(
  db: DbOrTx,
  producerId: string,
  since: Date
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(machineFindings)
    .where(
      and(eq(machineFindings.producerId, producerId), gte(machineFindings.createdAt, since))
    );
  return Number(row?.n ?? 0);
}
