import { and, eq, gt } from 'drizzle-orm';
import { judgeRecords } from '@/lib/db/schema';
import { Db } from '@/lib/core/eventlog';
import { canEnterTraining, type WorkspacePlan } from './tenancy';

export async function appendJudgeRecord(
  db: Db,
  input: {
    workspaceId: number;
    requestId: string;
    versionId: string;
    runId: string;
    payload: Record<string, unknown>;
  }
) {
  const [row] = await db
    .insert(judgeRecords)
    .values({
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      versionId: input.versionId,
      runId: input.runId,
      payload: input.payload,
    })
    .returning();
  return row;
}

export async function listJudgeRecords(
  db: Db,
  input: { workspaceId: number; afterId?: number; limit?: number }
) {
  const rows = await db
    .select()
    .from(judgeRecords)
    .where(
      input.afterId
        ? and(eq(judgeRecords.workspaceId, input.workspaceId), gt(judgeRecords.id, input.afterId))
        : eq(judgeRecords.workspaceId, input.workspaceId)
    )
    .orderBy(judgeRecords.id)
    .limit(input.limit ?? 200);
  return rows;
}

export function assertTrainingAllowed(plan: WorkspacePlan) {
  return canEnterTraining(plan);
}
