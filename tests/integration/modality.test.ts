import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview, submitVersion } from '@/lib/core/requests';
import {
  queues,
  reviewRequests,
  artifactVersions,
  events,
} from '@/lib/db/schema';

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures();
});

const base = {
  queueSlug: 'q',
  customerRequestId: 'pico/c1/acme/dana/seq1',
  title: 'Dana — seq 1',
  contentMd: 'Hello world, this is a text artifact.',
};

describe('queue modality column', () => {
  it('defaults to text when the insert omits it (no backfill required)', async () => {
    const queue = await db.query.queues.findFirst({ where: eq(queues.id, fx.queueId) });
    expect(queue?.modality).toBe('text');
  });
});

describe('ingest modality check', () => {
  async function counts() {
    const [requests, versions, ev] = await Promise.all([
      db.select().from(reviewRequests),
      db.select().from(artifactVersions),
      db.select().from(events),
    ]);
    return { requests: requests.length, versions: versions.length, events: ev.length };
  }

  it('rejects a mismatched artifact with modality_mismatch and writes nothing', async () => {
    const before = await counts();
    await expect(
      createReview(db, {
        projectId: fx.projectId,
        ...base,
        modality: 'code',
      })
    ).rejects.toMatchObject({ status: 409, code: 'modality_mismatch' });
    expect(await counts()).toEqual(before);
  });

  it('rejects text ingest into a non-text queue and writes nothing', async () => {
    await db.update(queues).set({ modality: 'table' }).where(eq(queues.id, fx.queueId));
    const before = await counts();
    await expect(
      createReview(db, { projectId: fx.projectId, ...base })
    ).rejects.toMatchObject({ status: 409, code: 'modality_mismatch' });
    expect(await counts()).toEqual(before);
  });

  it('accepts a text artifact on a text queue', async () => {
    const result = await createReview(db, { projectId: fx.projectId, ...base });
    expect(result.created).toBe(true);
    expect((await db.select().from(artifactVersions)).length).toBe(1);
  });

  it('rejects a mismatched submit_version and writes no new version', async () => {
    const { request } = await createReview(db, { projectId: fx.projectId, ...base });
    await db
      .update(reviewRequests)
      .set({ status: 'rejected' })
      .where(eq(reviewRequests.id, request.id));

    const before = await counts();
    await expect(
      submitVersion(db, {
        projectId: fx.projectId,
        customerRequestId: request.customerRequestId,
        contentMd: 'Regenerated body.',
        modality: 'image',
      })
    ).rejects.toMatchObject({ status: 409, code: 'modality_mismatch' });
    expect(await counts()).toEqual(before);
  });
});
