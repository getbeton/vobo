'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import { ApiProblem } from '@/lib/core/requests';
import { can, workspaceOfRequest } from '@/lib/core/authz';
import { claim, release } from '@/lib/core/queue';
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

export type ActionResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string; code: string };

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
  }) => {
    const user = await guardReviewer(input.requestId);
    const res = await ship(db, { ...input, userId: user.id });
    revalidatePath('/queue');
    revalidatePath(`/review/${input.requestId}`);
    return res;
  }
);

export const confirmResolutionAction = wrap(
  async (requestId: string, annotationId: string, versionId: string) => {
    await guardReviewer(requestId);
    await confirmResolution(db, requestId, annotationId, versionId);
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
