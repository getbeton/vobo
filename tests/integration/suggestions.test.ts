import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview, submitVersion } from '@/lib/core/requests';
import { claim } from '@/lib/core/queue';
import { setCriterionVerdict } from '@/lib/core/annotations';
import { ship } from '@/lib/core/verdict';
import {
  createSuggestion,
  acceptSuggestion,
  saveManualEdits,
} from '@/lib/core/suggestions';
import { artifactVersions, reviewRequests } from '@/lib/db/schema';

const BODY = 'The first claim is invented. The second paragraph is fine.';

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({ roundBudget: 2 });
});

async function scoreAll(requestId: string, verdict: 'pass' | 'fail') {
  for (const criterionId of fx.criterionIds) {
    await setCriterionVerdict(db, {
      requestId,
      criterionId,
      userId: fx.userId,
      verdict,
    });
  }
}

describe('VOBO-291: suggestions and Save manual edits', () => {
  it('Accept on a suggestion does not insert a version; Save writes one human version and stays', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/1',
      title: 'Dana',
      contentMd: BODY,
    });
    await claim(db, request.id, fx.userId);
    const start = BODY.indexOf('first claim');
    const sug = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: start,
      endPos: start + 'first claim'.length,
      replacement: 'opening line',
    });
    const before = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    expect(before).toHaveLength(1);
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: sug.id,
      userId: fx.userId,
    });
    const mid = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    expect(mid).toHaveLength(1);

    const saved = await saveManualEdits(db, { requestId: request.id, userId: fx.userId });
    expect(saved.round).toBe(2);
    const [row] = await db.select().from(reviewRequests).where(eq(reviewRequests.id, request.id));
    expect(row.status).toBe('claimed');
    expect(row.round).toBe(2);
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    expect(versions).toHaveLength(2);
    const human = versions.find((v) => v.humanAuthored);
    expect(human?.contentMd).toContain('opening line');
    expect(human?.contentMd).not.toContain('first claim');
  });

  it('Save with a pending suggestion is refused', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/2',
      title: 'Dana',
      contentMd: BODY,
    });
    await claim(db, request.id, fx.userId);
    await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: 0,
      endPos: 3,
      replacement: 'A',
    });
    await expect(saveManualEdits(db, { requestId: request.id, userId: fx.userId })).rejects.toMatchObject({
      code: 'pending_suggestions',
    });
  });
});

describe('VOBO-291: reject wall counts reject decisions, not versions', () => {
  it('Save then a second reject still ships at budget 2', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/wall',
      title: 'Dana',
      contentMd: BODY,
    });
    await claim(db, request.id, fx.userId);
    await scoreAll(request.id, 'fail');
    await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'reject_rerun',
    });
    const [afterFirst] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(afterFirst.budgetExhaustedAt).toBeNull();
    await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: BODY.replace('invented', 'grounded'),
    });
    await claim(db, request.id, fx.userId);
    const sug = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: 0,
      endPos: 3,
      replacement: 'THE',
    });
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: sug.id,
      userId: fx.userId,
    });
    await saveManualEdits(db, { requestId: request.id, userId: fx.userId });
    const [afterSave] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(afterSave.round).toBe(3);
    await scoreAll(request.id, 'fail');
    const second = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'reject_rerun',
    });
    expect(second.status).toBe('rejected');
    const [flagged] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(flagged.budgetExhaustedAt).toBeInstanceOf(Date);
  });
});
