'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { reviewRequests } from '@/lib/db/schema';
import { getUser } from '@/lib/db/queries';
import { ApiProblem } from '@/lib/core/requests';
import { can, workspaceOfRequest, workspaceOfQueue } from '@/lib/core/authz';
import { archiveRequests, claim, rankedQueue, release, unarchiveRequests } from '@/lib/core/queue';
import { exportFailingCsv } from '@/lib/core/failing';
import {
  addComment,
  editComment,
  resolveComment,
  setCriterionVerdict,
} from '@/lib/core/annotations';
import {
  ship,
  VerdictKind,
  approveGate,
  confirmResolution,
  markPersisting,
  repin,
  retire,
} from '@/lib/core/verdict';
import { confirmFinding, dismissFinding } from '@/lib/findings/triage';

export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string; code: string };

/**
 * Archive is an operator action, not a reviewer one. It removes work from the
 * board without a verdict, so it sits with the people who own the queue.
 */
async function guardOperator(requestId: string) {
  const user = await getUser();
  if (!user) throw new ApiProblem(401, 'unauthenticated', 'Sign in required');
  const wsId = await workspaceOfRequest(requestId);
  await can.operate(user.id, wsId);
  return { user, wsId };
}

async function guardReviewer(requestId: string) {
  const user = await getUser();
  if (!user) throw new ApiProblem(401, 'unauthenticated', 'Sign in required');
  const wsId = await workspaceOfRequest(requestId);
  await can.review(user.id, wsId);
  return user;
}

function wrap<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  return async (...args: A): Promise<ActionResult<T>> => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof ApiProblem) return { ok: false, error: err.message, code: err.code };
      console.error('review action error:', err);
      return { ok: false, error: 'Something went wrong', code: 'internal' };
    }
  };
}

export const claimAction = wrap(async (requestId: string) => {
  const user = await guardReviewer(requestId);
  const res = await claim(db, requestId, user.id);
  revalidatePath('/queue');
  return res;
});

export const releaseAction = wrap(async (requestId: string) => {
  const user = await guardReviewer(requestId);
  await release(db, requestId, user.id);
  revalidatePath('/queue');
});

export const addCommentAction = wrap(
  async (input: {
    requestId: string;
    body: string;
    startPos: number;
    endPos: number;
    parentId?: string;
  }) => {
    const user = await guardReviewer(input.requestId);
    const ann = await addComment(db, { ...input, userId: user.id });
    revalidatePath(`/review/${input.requestId}`);
    return { annotationId: ann.id };
  }
);

export const editCommentAction = wrap(
  async (requestId: string, annotationId: string, body: string) => {
    const user = await guardReviewer(requestId);
    await editComment(db, { requestId, annotationId, userId: user.id, body });
    revalidatePath(`/review/${requestId}`);
  }
);

export const resolveCommentAction = wrap(
  async (requestId: string, annotationId: string) => {
    const user = await guardReviewer(requestId);
    await resolveComment(db, requestId, annotationId, user.id);
    revalidatePath(`/review/${requestId}`);
  }
);

export const setCriterionAction = wrap(
  async (requestId: string, criterionId: string, verdict: 'pass' | 'fail' | 'na') => {
    const user = await guardReviewer(requestId);
    await setCriterionVerdict(db, { requestId, criterionId, userId: user.id, verdict });
    revalidatePath(`/review/${requestId}`);
  }
);

export const confirmFindingAction = wrap(async (requestId: string, findingId: string) => {
  const user = await guardReviewer(requestId);
  const res = await confirmFinding(db, { findingId, userId: user.id });
  revalidatePath(`/review/${requestId}`);
  return { verdict: res.verdict };
});

export const dismissFindingAction = wrap(
  async (requestId: string, findingId: string, reason?: string) => {
    const user = await guardReviewer(requestId);
    const res = await dismissFinding(db, { findingId, userId: user.id, reason });
    revalidatePath(`/review/${requestId}`);
    return { verdict: res.verdict };
  }
);

export const archiveRequestsAction = wrap(
  async (requestIds: string[], reason?: string) => {
    if (requestIds.length === 0) throw new ApiProblem(422, 'nothing_selected', 'Select at least one request');
    // Authorize against the first request's workspace, then refuse any id that
    // resolves to a different one — a mixed batch must never ride in on one
    // check.
    const { user, wsId } = await guardOperator(requestIds[0]);
    for (const id of requestIds.slice(1)) {
      if ((await workspaceOfRequest(id)) !== wsId)
        throw new ApiProblem(403, 'cross_workspace', 'The selection spans more than one workspace');
    }
    const res = await archiveRequests(db, { requestIds, userId: user.id, reason });
    revalidatePath('/queue');
    revalidatePath('/queue/failing');
    revalidatePath('/requests');
    return res;
  }
);

export const unarchiveRequestsAction = wrap(
  async (requestIds: string[], reason?: string) => {
    if (requestIds.length === 0)
      throw new ApiProblem(422, 'nothing_selected', 'Select at least one request');
    // Same two guards as archive: operator role, and one workspace per batch.
    const { user, wsId } = await guardOperator(requestIds[0]);
    for (const id of requestIds.slice(1)) {
      if ((await workspaceOfRequest(id)) !== wsId)
        throw new ApiProblem(403, 'cross_workspace', 'The selection spans more than one workspace');
    }
    const res = await unarchiveRequests(db, { requestIds, userId: user.id, reason });
    revalidatePath('/queue');
    revalidatePath('/queue/failing');
    revalidatePath('/requests');
    return res;
  }
);

export const exportFailingCsvAction = wrap(
  async (queueId: string, requestIds: string[]) => {
    const user = await getUser();
    if (!user) throw new ApiProblem(401, 'unauthenticated', 'Sign in required');
    const wsId = await workspaceOfQueue(queueId);
    await can.operate(user.id, wsId);
    const csv = await exportFailingCsv(db, { queueId, requestIds });
    return { csv, filename: 'failing-requests.csv' };
  }
);

export const gateAction = wrap(async (requestId: string) => {
  const user = await guardReviewer(requestId);
  return approveGate(db, requestId, user.id);
});

export const shipAction = wrap(
  async (input: {
    requestId: string;
    kind: VerdictKind;
    reason?: string;
    acknowledgeInterstitials?: boolean;
    editedContentMd?: string;
    overrideUntriagedFindings?: boolean;
    acceptedVersionId?: string;
  }) => {
    const user = await guardReviewer(input.requestId);
    const res = await ship(db, { ...input, userId: user.id });
    revalidatePath('/queue');
    revalidatePath('/queue/failing');
    revalidatePath(`/review/${input.requestId}`);
    // The reviewer stays in the queue instead of bouncing back to the list
    // 425 times. The ranking decides what "next" is, so the answer is the same
    // row the queue would have offered. The shipped request has left
    // open/claimed by now, so it cannot come back as its own successor.
    const request = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, input.requestId),
    });
    let nextRequestId: string | null = null;
    let nextLeaseMine = false;
    if (request) {
      const ranked = await rankedQueue(db, request.queueId, user.id);
      const next = ranked.find(
        (r) => r.request.id !== input.requestId && !(r.lease && r.lease.userId !== user.id)
      );
      nextRequestId = next?.request.id ?? null;
      nextLeaseMine = Boolean(next?.lease && next.lease.userId === user.id);
    }
    return { ...res, nextRequestId, nextLeaseMine };
  }
);

export const confirmResolutionAction = wrap(
  async (requestId: string, annotationId: string, versionId: string) => {
    const user = await guardReviewer(requestId);
    await confirmResolution(db, requestId, annotationId, versionId, user.id);
    revalidatePath(`/review/${requestId}`);
  }
);

export const markPersistingAction = wrap(
  async (requestId: string, annotationId: string, versionId: string) => {
    await guardReviewer(requestId);
    await markPersisting(db, requestId, annotationId, versionId);
    revalidatePath(`/review/${requestId}`);
  }
);

export const repinAction = wrap(
  async (input: {
    requestId: string;
    annotationId: string;
    versionId: string;
    newQuote: string;
    newStartPos: number;
    newEndPos: number;
  }) => {
    const user = await guardReviewer(input.requestId);
    await repin(db, { ...input, userId: user.id });
    revalidatePath(`/review/${input.requestId}`);
  }
);

export const retireAction = wrap(
  async (requestId: string, annotationId: string, reason: string) => {
    const user = await guardReviewer(requestId);
    await retire(db, { requestId, annotationId, userId: user.id, reason });
    revalidatePath(`/review/${requestId}`);
  }
);
