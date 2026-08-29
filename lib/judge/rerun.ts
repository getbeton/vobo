import { and, eq, isNull } from 'drizzle-orm';
import {
  artifactVersions,
  judgeRuns,
  machineFindings,
  policyVersions,
  projects,
  reviewRequests,
} from '@/lib/db/schema';
import { appendEvent, Db } from '@/lib/core/eventlog';
import { ApiProblem } from '@/lib/core/requests';
import { parsePolicyConfig } from '@/lib/core/policy';
import { BUILTIN_JUDGE_SLUG, ensureBuiltinProducer } from '@/lib/findings/producers';

const RERUNNABLE = new Set(['completed', 'failed', 'not_sampled']);

/**
 * Reset the existing judge_runs row for the current version. Does not insert a
 * second run, does not mint a version, does not re-roll blindness.
 */
export async function rerunJudge(
  db: Db,
  input: { requestId: string; versionId: string; userId: string }
) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, input.requestId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (locked.status === 'accepted') {
      throw new ApiProblem(409, 'already_accepted', 'Cannot rerun the judge on an accepted request');
    }
    if (locked.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');

    const version = await tx.query.artifactVersions.findFirst({
      where: eq(artifactVersions.id, input.versionId),
    });
    if (!version || version.requestId !== locked.id) {
      throw new ApiProblem(404, 'version_not_found', 'Version not found on this request');
    }
    if (version.versionNumber !== locked.round) {
      throw new ApiProblem(409, 'not_current_version', 'Rerun only the current version');
    }

    const pv = await tx.query.policyVersions.findFirst({
      where: eq(policyVersions.id, locked.policyVersionId),
    });
    if (!pv) throw new ApiProblem(404, 'policy_not_found', 'Policy not found');
    const policy = parsePolicyConfig(pv.config);
    if (!policy.judgeEnabled) {
      throw new ApiProblem(409, 'judge_disabled', 'Judge is disabled on this queue');
    }

    const run = await tx.query.judgeRuns.findFirst({
      where: eq(judgeRuns.versionId, version.id),
    });
    if (!run) throw new ApiProblem(404, 'judge_run_not_found', 'No judge run on this version');
    if (run.state === 'running') {
      throw new ApiProblem(409, 'judge_running', 'Judge is already running');
    }
    if (!RERUNNABLE.has(run.state)) {
      throw new ApiProblem(409, 'judge_not_rerunnable', `Cannot rerun a ${run.state} run`);
    }

    const project = await tx.query.projects.findFirst({
      where: eq(projects.id, locked.projectId),
    });
    if (!project) throw new ApiProblem(404, 'project_not_found', 'Project not found');
    const judgeProducer = await ensureBuiltinProducer(
      tx,
      project.id,
      BUILTIN_JUDGE_SLUG,
      'Vobo built-in judge'
    );

    await tx
      .update(machineFindings)
      .set({ purgedAt: new Date() })
      .where(
        and(
          eq(machineFindings.versionId, version.id),
          eq(machineFindings.producerId, judgeProducer.id),
          isNull(machineFindings.purgedAt)
        )
      );

    const nextSeq = run.rerunSeq + 1;
    await tx
      .update(judgeRuns)
      .set({
        state: 'pending',
        attempts: 0,
        lastAttemptAt: null,
        startedAt: null,
        completedAt: null,
        overallScore: null,
        errorClass: null,
        errorMessage: null,
        rerunSeq: nextSeq,
      })
      .where(eq(judgeRuns.id, run.id));

    await appendEvent(tx, locked.id, 'judge.rerun_requested', {
      run_id: run.id,
      version_id: version.id,
      rerun_seq: nextSeq,
      user_id: input.userId,
    });

    return { runId: run.id, rerunSeq: nextSeq };
  });
}
