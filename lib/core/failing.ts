import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { decisions, policyVersions, queues, reviewRequests } from '@/lib/db/schema';
import { can } from './authz';
import { Db, DbOrTx } from './eventlog';
import { parsePolicyConfig } from './policy';

/**
 * Requests that used the last policy round. A reject at round >= roundBudget
 * ships as a normal reject and sets budget_exhausted_at; this list is the
 * extra signal for operators. Status stays rejected (or whatever followed).
 */

export interface FailingRow {
  id: string;
  title: string;
  status: string;
  round: number;
  roundBudget: number;
  queueSlug: string;
  flaggedAt: Date;
  lastDecisionKind: string | null;
  customerRequestId: string;
  archivedAt: Date | null;
}

export async function listFailingRequests(
  db: DbOrTx,
  input: { queueId: string }
): Promise<FailingRow[]> {
  const rows = await db
    .select({
      request: reviewRequests,
      queueSlug: queues.slug,
      policyConfig: policyVersions.config,
    })
    .from(reviewRequests)
    .innerJoin(queues, eq(queues.id, reviewRequests.queueId))
    .innerJoin(policyVersions, eq(policyVersions.id, reviewRequests.policyVersionId))
    .where(
      and(
        eq(reviewRequests.queueId, input.queueId),
        isNotNull(reviewRequests.budgetExhaustedAt),
        ne(reviewRequests.status, 'accepted')
      )
    )
    .orderBy(desc(reviewRequests.budgetExhaustedAt));

  const ids = rows.map((r) => r.request.id);
  const lastKind = new Map<string, string>();
  if (ids.length > 0) {
    const decisionRows = await db
      .select({ requestId: decisions.requestId, kind: decisions.kind, createdAt: decisions.createdAt })
      .from(decisions)
      .where(inArray(decisions.requestId, ids))
      .orderBy(desc(decisions.createdAt));
    for (const d of decisionRows) {
      if (!lastKind.has(d.requestId)) lastKind.set(d.requestId, d.kind);
    }
  }

  return rows.map(({ request, queueSlug, policyConfig }) => {
    const policy = parsePolicyConfig(policyConfig);
    return {
      id: request.id,
      title: request.title,
      status: request.status,
      round: request.round,
      roundBudget: policy.roundBudget,
      queueSlug,
      flaggedAt: request.budgetExhaustedAt!,
      lastDecisionKind: lastKind.get(request.id) ?? null,
      customerRequestId: request.customerRequestId,
      archivedAt: request.archivedAt,
    };
  });
}

/** Operator/admin only. A reviewer gets 403. */
export async function listFailingForOperator(
  db: Db,
  input: { userId: string; workspaceId: number; queueId: string }
): Promise<FailingRow[]> {
  await can.operate(input.userId, input.workspaceId);
  return listFailingRequests(db, { queueId: input.queueId });
}

function csvField(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_COLUMNS = [
  'id',
  'title',
  'status',
  'round',
  'roundBudget',
  'queue',
  'flagged_at',
  'last_decision_kind',
  'customer_request_id',
] as const;

/** RFC4180: quotes around fields that contain comma, quote, or newline. */
export function failingRowsToCsv(rows: FailingRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.id),
        csvField(r.title),
        csvField(r.status),
        csvField(r.round),
        csvField(r.roundBudget),
        csvField(r.queueSlug),
        csvField(r.flaggedAt.toISOString()),
        csvField(r.lastDecisionKind ?? ''),
        csvField(r.customerRequestId),
      ].join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

export async function exportFailingCsv(
  db: DbOrTx,
  input: { queueId: string; requestIds?: string[] }
): Promise<string> {
  let rows = await listFailingRequests(db, { queueId: input.queueId });
  if (input.requestIds && input.requestIds.length > 0) {
    const want = new Set(input.requestIds);
    rows = rows.filter((r) => want.has(r.id));
  }
  return failingRowsToCsv(rows);
}

export async function exportFailingCsvForOperator(
  db: Db,
  input: { userId: string; workspaceId: number; queueId: string; requestIds?: string[] }
): Promise<string> {
  await can.operate(input.userId, input.workspaceId);
  return exportFailingCsv(db, { queueId: input.queueId, requestIds: input.requestIds });
}
