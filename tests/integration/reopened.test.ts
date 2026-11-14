import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
import path from 'path';
import { ensureMigrated, truncateAll, createFixtures, db, client, Fixtures } from './harness';
import { reviewRequests, events } from '@/lib/db/schema';
import { createReview, submitVersion, reopenByLateFinding } from '@/lib/core/requests';
import { claim } from '@/lib/core/queue';
import { ship } from '@/lib/core/verdict';
import { setCriterionVerdict } from '@/lib/core/annotations';
import { getVerifiedChain } from '@/lib/core/eventlog';
import { GET as listReviews } from '@/app/api/v1/reviews/route';
import { GET as getReview } from '@/app/api/v1/review/route';
import {
  alreadyShipped,
  billableUnits,
  INTEGRATE_COPY,
  isAwaitingVersion,
  REOPEN_EVENT_TYPE,
} from '@/lib/core/pull-contract';

/**
 * VOBO-194. `accepted` is terminal for the round, not the request. A late
 * critical finding reopens it. The four-state pull contract publishes
 * `reopened` as awaiting_version plus already_shipped.
 */

const BODY = 'Hello Dana — here is the artifact under review.';

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({ roundBudget: 3, slaMinutes: null });
});

afterAll(async () => {
  await client.end();
});

async function createAndAccept(customerRequestId = 'pico/reopen/1') {
  const { request } = await createReview(db, {
    projectId: fx.projectId,
    queueSlug: 'q',
    environment: 'production',
    customerRequestId,
    title: 'Reopen subject',
    contentMd: BODY,
  });
  await claim(db, request.id, fx.userId);
  for (const criterionId of fx.criterionIds) {
    await setCriterionVerdict(db, {
      requestId: request.id,
      criterionId,
      userId: fx.userId,
      verdict: 'pass',
    });
  }
  const shipped = await ship(db, {
    requestId: request.id,
    userId: fx.userId,
    kind: 'approve',
  });
  expect(shipped.status).toBe('accepted');
  return request;
}

async function list(query: string) {
  const res = await listReviews(
    new Request(`http://localhost/api/v1/reviews?${query}`, {
      headers: { authorization: `Bearer ${fx.apiToken}` },
    })
  );
  return { status: res.status, body: await res.json() };
}

describe('reopened status and the four-state pull contract', () => {
  it('isAwaitingVersion is rejected and reopened, never accepted', () => {
    expect(isAwaitingVersion('rejected')).toBe(true);
    expect(isAwaitingVersion('reopened')).toBe(true);
    expect(isAwaitingVersion('accepted')).toBe(false);
    expect(alreadyShipped('reopened')).toBe(true);
    expect(alreadyShipped('rejected')).toBe(false);
  });

  it('/integrate copy teaches the four states including reopened', () => {
    expect(INTEGRATE_COPY).toMatch(/accepted — terminal for this round/i);
    expect(INTEGRATE_COPY).toMatch(/reopened — a late critical/i);
    expect(INTEGRATE_COPY).toMatch(/already_shipped/);
    expect(INTEGRATE_COPY).toMatch(/awaiting_version — the work list/i);
    expect(INTEGRATE_COPY).toMatch(/open \(also claimed/);
    expect(INTEGRATE_COPY).toMatch(/polls only this filter still observes a reopen/);
    expect(INTEGRATE_COPY).toMatch(/consumes no extra unit/);
  });

  it('MCP list_reviews surfaces reopened on the pull contract', () => {
    const src = readFileSync(path.join(process.cwd(), 'mcp/server.ts'), 'utf8');
    expect(src).toMatch(/list_reviews/);
    expect(src).toMatch(/reopened/);
    expect(src).toMatch(/already_shipped/);
    expect(src).toMatch(/open,claimed,rejected,accepted,escalated,reopened/);
  });

  it('reopen from accepted emits already_shipped and consumes no extra billable unit', async () => {
    const request = await createAndAccept();
    const [{ n: before }] = await db
      .select({ n: count() })
      .from(reviewRequests)
      .where(eq(reviewRequests.projectId, fx.projectId));

    const finding = {
      severity: 'critical' as const,
      id: 'finding-late-1',
      criterion: 'voice',
      note: 'Banned superlative landed after the judge run finished pending.',
      producer: 'judge',
    };
    const reopened = await reopenByLateFinding(db, { requestId: request.id, finding });
    expect(reopened.created).toBe(true);
    expect(reopened.request.status).toBe('reopened');
    expect(reopened.request.acceptedHash).toBeTruthy();

    const [{ n: after }] = await db
      .select({ n: count() })
      .from(reviewRequests)
      .where(eq(reviewRequests.projectId, fx.projectId));
    expect(after).toBe(before);
    expect(billableUnits(Number(after))).toBe(billableUnits(Number(before)));
    expect(billableUnits(Number(after))).toBe(1);

    const { rows, verification } = await getVerifiedChain(db, request.id);
    expect(verification.ok).toBe(true);
    const accepted = rows.find((r) => r.type === 'decision.accepted');
    expect(accepted).toBeTruthy();
    const reopen = rows.find((r) => r.type === REOPEN_EVENT_TYPE);
    expect(reopen).toBeTruthy();
    expect(reopen!.payload).toMatchObject({
      already_shipped: true,
      from_status: 'accepted',
      finding,
    });
    // The original acceptance stands, unaltered, earlier in the chain.
    expect(rows.indexOf(accepted!)).toBeLessThan(rows.indexOf(reopen!));
  });

  it('a consumer polling only awaiting_version still observes the reopen', async () => {
    const request = await createAndAccept('pico/reopen/poll');

    const before = await list('queue=q&awaiting_version=true');
    expect(before.body.reviews).toEqual([]);

    await reopenByLateFinding(db, {
      requestId: request.id,
      finding: {
        severity: 'critical',
        id: 'finding-late-2',
        note: 'Late critical.',
      },
    });

    const awaiting = await list('queue=q&awaiting_version=true');
    expect(awaiting.status).toBe(200);
    expect(awaiting.body.reviews).toHaveLength(1);
    const row = awaiting.body.reviews[0];
    expect(row.request_id).toBe('pico/reopen/poll');
    expect(row.status).toBe('reopened');
    expect(row.awaiting_version).toBe(true);
    expect(row.already_shipped).toBe(true);

    const filtered = await list('queue=q&status=reopened');
    expect(filtered.body.reviews).toHaveLength(1);
    expect(filtered.body.reviews[0].status).toBe('reopened');

    const rejectedOnly = await list('queue=q&status=rejected');
    expect(rejectedOnly.body.reviews).toHaveLength(0);

    const point = await getReview(
      new Request('http://localhost/api/v1/review?request_id=pico/reopen/poll', {
        headers: { authorization: `Bearer ${fx.apiToken}` },
      })
    );
    const body = await point.json();
    expect(body.status).toBe('reopened');
    expect(body.awaiting_version).toBe(true);
    expect(body.already_shipped).toBe(true);
  });

  it('changed_since includes the reopen event', async () => {
    const request = await createAndAccept('pico/reopen/stream');
    const before = await list('queue=q');
    const cursor = before.body.max_event_id;
    expect(cursor).toBeTruthy();

    await reopenByLateFinding(db, {
      requestId: request.id,
      finding: { severity: 'critical', id: 'finding-late-3', note: 'Late critical.' },
    });

    const delta = await list(`queue=q&changed_since=${cursor}`);
    const hit = delta.body.reviews.find((r: { id: string }) => r.id === request.id);
    expect(hit).toBeTruthy();
    expect(hit.status).toBe('reopened');
    expect(hit.awaiting_version).toBe(true);
    expect(hit.already_shipped).toBe(true);
    expect(delta.body.max_event_id).toBeGreaterThan(cursor);

    const reopenRows = await db
      .select()
      .from(events)
      .where(eq(events.requestId, request.id));
    expect(reopenRows.some((r) => r.type === REOPEN_EVENT_TYPE)).toBe(true);
  });

  it('submit version is valid on reopened and returns the request to open', async () => {
    const request = await createAndAccept('pico/reopen/v2');
    await reopenByLateFinding(db, {
      requestId: request.id,
      finding: { severity: 'critical', id: 'finding-late-4', note: 'Late critical.' },
    });
    const v2 = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: 'pico/reopen/v2',
      contentMd: BODY + '\n\nRegenerated after the late critical.',
    });
    expect(v2.created).toBe(true);
    expect(v2.request.status).toBe('open');
    expect(v2.request.round).toBe(2);
  });

  it('only a critical finding on an accepted request reopens', async () => {
    const request = await createAndAccept('pico/reopen/gate');
    await expect(
      reopenByLateFinding(db, {
        requestId: request.id,
        finding: { severity: 'minor', note: 'nit' },
      })
    ).rejects.toMatchObject({ status: 422, code: 'not_critical' });

    const { request: openReq } = await createReview(db, {
      projectId: fx.projectId,
      queueSlug: 'q',
      customerRequestId: 'pico/reopen/still-open',
      title: 'Still open',
      contentMd: BODY,
    });
    await expect(
      reopenByLateFinding(db, {
        requestId: openReq.id,
        finding: { severity: 'critical', note: 'too early' },
      })
    ).rejects.toMatchObject({ status: 409, code: 'not_accepted' });
  });

  it('a second reopen of the same request is a no-op', async () => {
    const request = await createAndAccept('pico/reopen/idem');
    const first = await reopenByLateFinding(db, {
      requestId: request.id,
      finding: { severity: 'critical', id: 'a', note: 'first' },
    });
    const second = await reopenByLateFinding(db, {
      requestId: request.id,
      finding: { severity: 'critical', id: 'b', note: 'second' },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const reopenEvents = await db
      .select()
      .from(events)
      .where(eq(events.requestId, request.id));
    expect(reopenEvents.filter((r) => r.type === REOPEN_EVENT_TYPE)).toHaveLength(1);
  });
});
