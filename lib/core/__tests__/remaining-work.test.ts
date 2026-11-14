import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { remainingWork, remainingWorkLabel, remainingWorkTitle } from '../metrics';
import { remainingWorkForQueue } from '../remaining-work';
import { ensureMigrated, truncateAll, createFixtures, db } from '../../../tests/integration/harness';
import { createReview } from '../requests';
import { reviewRequests } from '@/lib/db/schema';

describe('VOBO-296: remaining work counts', () => {
  it('counts remaining as not-accepted live rows; rejected is remaining', () => {
    const rows = [
      ...Array.from({ length: 15 }, () => ({ status: 'accepted' })),
      ...Array.from({ length: 64 }, () => ({ status: 'open' })),
      ...Array.from({ length: 2 }, () => ({ status: 'claimed' })),
      ...Array.from({ length: 4 }, () => ({ status: 'rejected' })),
    ];
    const w = remainingWork(rows);
    expect(w.remaining).toBe(70);
    expect(w.accepted).toBe(15);
    expect(w.split).toEqual({
      open: 64,
      claimed: 2,
      rejected: 4,
      escalated: 0,
      held_blind: 0,
    });
    expect(remainingWorkLabel(w)).toBe('70 remaining · 15 accepted');
    expect(remainingWorkTitle(w)).toBe(
      'open 64 / claimed 2 / rejected 4 / escalated 0 / held_blind 0'
    );
  });

  it('one live rejected request is remaining 1', () => {
    expect(remainingWork([{ status: 'rejected' }])).toEqual({
      remaining: 1,
      accepted: 0,
      split: { open: 0, claimed: 0, rejected: 1, escalated: 0, held_blind: 0 },
    });
  });

  it('all accepted is remaining 0', () => {
    const w = remainingWork([{ status: 'accepted' }, { status: 'accepted' }]);
    expect(w.remaining).toBe(0);
    expect(w.accepted).toBe(2);
    expect(remainingWorkLabel(w)).toBe('0 remaining · 2 accepted');
  });

  it('accept moves one remaining row to accepted', () => {
    const before = remainingWork([
      ...Array.from({ length: 15 }, () => ({ status: 'accepted' })),
      ...Array.from({ length: 64 }, () => ({ status: 'open' })),
      ...Array.from({ length: 2 }, () => ({ status: 'claimed' })),
      ...Array.from({ length: 4 }, () => ({ status: 'rejected' })),
    ]);
    const after = remainingWork([
      ...Array.from({ length: 16 }, () => ({ status: 'accepted' })),
      ...Array.from({ length: 63 }, () => ({ status: 'open' })),
      ...Array.from({ length: 2 }, () => ({ status: 'claimed' })),
      ...Array.from({ length: 4 }, () => ({ status: 'rejected' })),
    ]);
    expect(before.remaining).toBe(70);
    expect(after.remaining).toBe(69);
    expect(after.accepted).toBe(16);
  });

  it('does not reuse computeMetrics.open (rejected stays in remaining)', () => {
    const w = remainingWork([{ status: 'rejected' }, { status: 'held_blind' }]);
    expect(w.remaining).toBe(2);
    expect(w.split.rejected).toBe(1);
    expect(w.split.held_blind).toBe(1);
  });
});

describe('VOBO-296: remainingWorkForQueue ignores archived and other queues', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('counts live rows on this queue only; archived stay out', async () => {
    const fx = await createFixtures();
    const liveOpen = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/rw/live-open',
      title: 'live open',
      contentMd: 'Hello.',
    });
    const liveAccepted = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/rw/live-accepted',
      title: 'live accepted',
      contentMd: 'Hello.',
    });
    const liveRejected = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/rw/live-rejected',
      title: 'live rejected',
      contentMd: 'Hello.',
    });
    const archivedOpen = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/rw/archived-open',
      title: 'archived open',
      contentMd: 'Hello.',
    });
    await db
      .update(reviewRequests)
      .set({ status: 'accepted' })
      .where(eq(reviewRequests.id, liveAccepted.request.id));
    await db
      .update(reviewRequests)
      .set({ status: 'rejected' })
      .where(eq(reviewRequests.id, liveRejected.request.id));
    await db
      .update(reviewRequests)
      .set({ archivedAt: new Date() })
      .where(eq(reviewRequests.id, archivedOpen.request.id));

    const other = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      environment: 'test',
      customerRequestId: 'pico/rw/other-env',
      title: 'other env',
      contentMd: 'Hello.',
    });
    expect(other.request.queueId).not.toBe(fx.queueId);
    expect(liveOpen.request.queueId).toBe(fx.queueId);

    const w = await remainingWorkForQueue(db, fx.queueId);
    expect(w).toEqual({
      remaining: 2,
      accepted: 1,
      split: { open: 1, claimed: 0, rejected: 1, escalated: 0, held_blind: 0 },
    });
  });
});

