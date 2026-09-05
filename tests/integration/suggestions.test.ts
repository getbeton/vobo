import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview, submitVersion } from '@/lib/core/requests';
import { claim } from '@/lib/core/queue';
import { setCriterionVerdict, addComment } from '@/lib/core/annotations';
import { ship } from '@/lib/core/verdict';
import {
  createSuggestion,
  acceptSuggestion,
  saveManualEdits,
} from '@/lib/core/suggestions';
import { getVerifiedChain } from '@/lib/core/eventlog';
import { artifactVersions, reviewRequests, anchorStates, annotations } from '@/lib/db/schema';

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
  it('empty replacement is a delete suggestion; Accept folds it out', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/del',
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
      replacement: '',
    });
    expect(sug.replacement).toBe('');
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: sug.id,
      userId: fx.userId,
    });
    const saved = await saveManualEdits(db, { requestId: request.id, userId: fx.userId });
    const latest = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    const human = latest.find((v) => v.versionNumber === saved.round);
    expect(human?.contentMd).toBe(BODY.replace('first claim', ''));
  });

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

  it('accept later then earlier still saves the working text', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/order',
      title: 'Dana',
      contentMd: BODY,
    });
    await claim(db, request.id, fx.userId);
    const firstStart = BODY.indexOf('first claim');
    const secondStart = BODY.indexOf('second');
    const later = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: secondStart,
      endPos: secondStart + 'second'.length,
      replacement: '2nd',
    });
    const earlier = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: firstStart,
      endPos: firstStart + 'first claim'.length,
      replacement: 'opening line',
    });
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: later.id,
      userId: fx.userId,
    });
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: earlier.id,
      userId: fx.userId,
    });
    const saved = await saveManualEdits(db, { requestId: request.id, userId: fx.userId });
    const human = (
      await db.select().from(artifactVersions).where(eq(artifactVersions.requestId, request.id))
    ).find((v) => v.versionNumber === saved.round);
    expect(human?.contentMd).toBe(BODY.replace('first claim', 'opening line').replace('second', '2nd'));
  });

  it('Save classifies live comments onto the human version', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/classify',
      title: 'Dana',
      contentMd: BODY,
    });
    await claim(db, request.id, fx.userId);
    const quoteStart = BODY.indexOf('second paragraph');
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'Keep this',
      startPos: quoteStart,
      endPos: quoteStart + 'second paragraph'.length,
    });
    const start = BODY.indexOf('first claim');
    const sug = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: start,
      endPos: start + 'first claim'.length,
      replacement: 'opening line',
    });
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: sug.id,
      userId: fx.userId,
    });
    const saved = await saveManualEdits(db, { requestId: request.id, userId: fx.userId });
    const [ann] = await db
      .select()
      .from(annotations)
      .where(eq(annotations.requestId, request.id));
    expect(ann.bornRound).toBe(1);
    expect(ann.quote).toBe('second paragraph');
    const states = await db
      .select()
      .from(anchorStates)
      .where(eq(anchorStates.versionId, saved.version.id));
    expect(states.length).toBeGreaterThan(0);
    expect(states.some((s) => s.newQuote === 'second paragraph')).toBe(true);
  });

  it('ship refuses while a suggestion is still pending', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/ship',
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
    await expect(
      ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_rerun' })
    ).rejects.toMatchObject({ code: 'unsaved_suggestions' });
    await expect(
      ship(db, {
        requestId: request.id,
        userId: fx.userId,
        kind: 'approve_edited',
        editedContentMd: 'Human rewrite.',
      })
    ).rejects.toMatchObject({ code: 'unsaved_suggestions' });
  });

  it('Accept overlapping a comment writes anchor.retired', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/overlap',
      title: 'Dana',
      contentMd: BODY,
    });
    await claim(db, request.id, fx.userId);
    const start = BODY.indexOf('first claim');
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'Invented',
      startPos: start,
      endPos: start + 'first claim'.length,
    });
    const other = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: start,
      endPos: start + 4,
      replacement: 'xx',
    });
    const sug = await createSuggestion(db, {
      requestId: request.id,
      userId: fx.userId,
      startPos: start,
      endPos: start + 'first claim'.length,
      replacement: 'opening line',
    });
    await acceptSuggestion(db, {
      requestId: request.id,
      suggestionId: sug.id,
      userId: fx.userId,
    });
    const { rows } = await getVerifiedChain(db, request.id);
    const types = rows.map((r) => r.type);
    expect(types).toContain('anchor.retired');
    expect(types).toContain('suggestion.rejected');
    const rejected = rows.find((r) => r.type === 'suggestion.rejected');
    expect((rejected?.payload as { suggestion_id: string }).suggestion_id).toBe(other.id);
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
    expect(second.status).toBe('escalated');
    const [flagged] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(flagged.budgetExhaustedAt).toBeInstanceOf(Date);
    expect(flagged.status).toBe('escalated');
  });

  it('Save then the first reject at budget 2 is still a rewrite', async () => {
    const { request } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'sug/wall-save-first',
      title: 'Dana',
      contentMd: BODY,
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
    await scoreAll(request.id, 'fail');
    const first = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'reject_rerun',
    });
    expect(first.status).toBe('rejected');
    const [row] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(row.status).toBe('rejected');
    expect(row.budgetExhaustedAt).toBeNull();
  });
});
