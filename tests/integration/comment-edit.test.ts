import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, client, ensureMigrated, truncateAll, createFixtures } from './harness';
import { annotations, events, user as userTable } from '@/lib/db/schema';
import { createReview } from '@/lib/core/requests';
import { addComment, editComment, resolveComment } from '@/lib/core/annotations';
import { getVerifiedChain } from '@/lib/core/eventlog';

/**
 * VOBO-222. A correction is the payload that ships with a rejection, so a wrong
 * one is worse than no comment. Until now the only exits were "resolve" and
 * "leave it". These pin the edit path.
 */
describe('editComment', () => {
  let fixtures: Awaited<ReturnType<typeof createFixtures>>;
  let requestId: string;
  let annotationId: string;
  const CONTENT = 'The first line is wrong.\n\nThe second line is fine.';

  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
    fixtures = await createFixtures();
    const { request } = await createReview(db, {
      projectId: fixtures.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'edit/one',
      title: 'Edit test',
      contentMd: CONTENT,
    });
    requestId = request.id;
    const ann = await addComment(db, {
      requestId,
      userId: fixtures.userId,
      body: 'This claim is invented.',
      startPos: 4,
      endPos: 14,
    });
    annotationId = ann.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it('replaces the body and leaves the anchor alone', async () => {
    const before = await db.query.annotations.findFirst({
      where: eq(annotations.id, annotationId),
    });
    await editComment(db, {
      requestId,
      annotationId,
      userId: fixtures.userId,
      body: 'This claim is not in the dossier.',
    });
    const after = await db.query.annotations.findFirst({
      where: eq(annotations.id, annotationId),
    });
    expect(after!.body).toBe('This claim is not in the dossier.');
    // The matcher re-anchors on these. Moving them would silently change which
    // span a persisting correction refers to.
    expect(after!.startPos).toBe(before!.startPos);
    expect(after!.endPos).toBe(before!.endPos);
    expect(after!.quote).toBe(before!.quote);
    expect(after!.prefix).toBe(before!.prefix);
    expect(after!.suffix).toBe(before!.suffix);
  });

  it('appends an event carrying the previous body', async () => {
    await editComment(db, {
      requestId,
      annotationId,
      userId: fixtures.userId,
      body: 'Rewritten.',
    });
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, requestId), eq(events.type, 'annotation.edited')));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.previous_body).toBe('This claim is invented.');
    expect(payload.body).toBe('Rewritten.');
    expect(payload.by).toBe(fixtures.userId);
  });

  it('keeps the hash chain verifiable', async () => {
    await editComment(db, {
      requestId,
      annotationId,
      userId: fixtures.userId,
      body: 'Rewritten twice.',
    });
    const { verification } = await getVerifiedChain(db, requestId);
    expect(verification.ok).toBe(true);
  });

  it('refuses a resolved comment', async () => {
    await resolveComment(db, requestId, annotationId, fixtures.userId);
    await expect(
      editComment(db, { requestId, annotationId, userId: fixtures.userId, body: 'Too late.' })
    ).rejects.toMatchObject({ code: 'already_resolved' });
  });

  it('refuses an author who did not write it', async () => {
    const other = 'u_other_' + Math.abs(fixtures.workspaceId);
    await db.insert(userTable).values({
      id: other,
      name: 'Other Reviewer',
      email: `${other}@test.local`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      editComment(db, { requestId, annotationId, userId: other, body: 'Not mine.' })
    ).rejects.toMatchObject({ code: 'not_the_author' });
  });

  it('refuses an empty body', async () => {
    await expect(
      editComment(db, { requestId, annotationId, userId: fixtures.userId, body: '   ' })
    ).rejects.toMatchObject({ code: 'empty_body' });
  });

  it('writes no event when the body is unchanged', async () => {
    await editComment(db, {
      requestId,
      annotationId,
      userId: fixtures.userId,
      body: 'This claim is invented.',
    });
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.requestId, requestId), eq(events.type, 'annotation.edited')));
    expect(rows).toHaveLength(0);
  });

  it('refuses an annotation from another request', async () => {
    const { request: other } = await createReview(db, {
      projectId: fixtures.projectId,
      queueSlug: 'q',
      environment: 'production',
      customerRequestId: 'edit/two',
      title: 'Other',
      contentMd: CONTENT,
    });
    await expect(
      editComment(db, {
        requestId: other.id,
        annotationId,
        userId: fixtures.userId,
        body: 'Wrong request.',
      })
    ).rejects.toMatchObject({ code: 'annotation_not_found' });
  });
});
