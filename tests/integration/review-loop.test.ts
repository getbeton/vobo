import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview, submitVersion, ApiProblem } from '@/lib/core/requests';
import { claim, release, rankedQueue, expireLeases, applySlaTimeouts } from '@/lib/core/queue';
import { addComment, resolveComment, setCriterionVerdict } from '@/lib/core/annotations';
import {
  approveGate,
  ship,
  outgoingCorrections,
  confirmResolution,
  markPersisting,
  retire,
  repin,
} from '@/lib/core/verdict';
import { getVerifiedChain } from '@/lib/core/eventlog';
import { contentHash } from '@/lib/core/events';
import { listFailingRequests } from '@/lib/core/failing';
import { artifactVersions, reviewRequests } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

const V1 = `Subject: quick question about your review stack

Hi Dana, saw your team ships weekly.

We sincerely apologize for the interruption, but our 60-day goodwill window makes this the best tool you'll ever use.

Worth a look?`;

const V2_FIXES_ONE = V1.replace(
  "We sincerely apologize for the interruption, but our 60-day goodwill window makes this the best tool you'll ever use.",
  'We cut the interruption short: our 60-day goodwill window makes this the rare tool you evaluate in one afternoon.'
);

let fx: Fixtures;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures({ roundBudget: 3, slaMinutes: null, leaseMinutes: 60 });
});

function baseCreate(overrides: Record<string, unknown> = {}) {
  return createReview(db, {
    projectId: fx.projectId,
    queueSlug: 'q',
    customerRequestId: 'pico/c1/acme/dana/seq1',
    title: 'Dana — seq 1',
    contentMd: V1,
    prompt: 'Write per voice rules',
    source: 'Dossier: Acme ships weekly',
    ...overrides,
  } as any);
}

describe('API contract: create review / submit version', () => {
  it('creates request + v1 with events; repeat call is a no-op upsert', async () => {
    const first = await baseCreate();
    expect(first.created).toBe(true);
    const again = await baseCreate();
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);

    const { rows, verification } = await getVerifiedChain(db, first.request.id);
    expect(verification.ok).toBe(true);
    expect(rows.map((r) => r.type)).toEqual(['request.created', 'version.submitted']);
  });

  it('submit version on unknown id is 404 — never implicit create', async () => {
    await expect(
      submitVersion(db, {
        projectId: fx.projectId,
        customerRequestId: 'nope',
        contentMd: 'x',
      })
    ).rejects.toMatchObject({ status: 404, code: 'request_not_found' });
  });

  it('submit version requires rejected status', async () => {
    const { request } = await baseCreate();
    await expect(
      submitVersion(db, {
        projectId: fx.projectId,
        customerRequestId: request.customerRequestId,
        contentMd: V2_FIXES_ONE,
      })
    ).rejects.toMatchObject({ status: 409, code: 'not_awaiting_version' });
  });
});

async function reviewAndReject(requestId: string) {
  await claim(db, requestId, fx.userId);
  // Anchor a correction on the apology/superlative sentence.
  const start = V1.indexOf('We sincerely apologize');
  const end = V1.indexOf('ever use.') + 'ever use.'.length;
  const ann = await addComment(db, {
    requestId,
    userId: fx.userId,
    body: 'Apology boilerplate + superlative — rewrite per voice rules.',
    expected: 'No apology; concrete value prop, no superlatives.',
    startPos: start,
    endPos: end,
  });
  for (const cid of fx.criterionIds) {
    await setCriterionVerdict(db, {
      requestId,
      criterionId: cid,
      userId: fx.userId,
      verdict: 'fail',
    });
  }
  const shipped = await ship(db, {
    requestId,
    userId: fx.userId,
    kind: 'reject_corrections',
  });
  expect(shipped.status).toBe('rejected');
  return ann;
}

describe('full regeneration loop with gates', () => {
  it('reject-with-corrections → v2 → classification → gates → approve seals hash', async () => {
    const { request } = await baseCreate();

    // Criteria gate blocks verdicts before scoring.
    await claim(db, request.id, fx.userId);
    await expect(
      ship(db, { requestId: request.id, userId: fx.userId, kind: 'approve' })
    ).rejects.toMatchObject({ code: 'criteria_unscored' });
    await release(db, request.id, fx.userId);

    const ann = await reviewAndReject(request.id);

    // Outgoing payload carried the anchored correction.
    const { rows } = await getVerifiedChain(db, request.id);
    const rejected = rows.find((r) => r.type === 'decision.rejected')!;
    expect((rejected.payload as any).corrections).toHaveLength(1);
    expect((rejected.payload as any).corrections[0].expected).toContain('No apology');

    // v2 fixes the anchored sentence.
    const v2 = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: V2_FIXES_ONE,
      responses: [{ annotationId: ann.id, note: 'rewrote the paragraph' }],
    });
    expect(v2.created).toBe(true);
    expect(v2.classifications).toMatchObject({ resolved: 1, persisting: 0, orphaned: 0 });
    expect(v2.request.status).toBe('open');
    expect(v2.request.round).toBe(2);
    expect(v2.request.stickyReviewerId).toBe(fx.userId);

    // Idempotent resubmission is a no-op.
    const dupe = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: V2_FIXES_ONE,
    });
    expect(dupe.created).toBe(false);

    // Round 2 review: gate demands criteria again, then interstitial for the
    // unconfirmed resolution.
    await claim(db, request.id, fx.userId);
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);
    expect(gate.interstitials.join(' ')).toContain('auto-confirmed');

    await expect(
      ship(db, { requestId: request.id, userId: fx.userId, kind: 'approve' })
    ).rejects.toMatchObject({ code: 'interstitial_unacknowledged' });

    const approved = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
      acknowledgeInterstitials: true,
    });
    expect(approved.status).toBe('accepted');
    expect(approved.sealedHash).toMatch(/^[0-9a-f]{64}$/);

    // Terminal: further versions are rejected.
    await expect(
      submitVersion(db, {
        projectId: fx.projectId,
        customerRequestId: request.customerRequestId,
        contentMd: 'anything',
      })
    ).rejects.toMatchObject({ code: 'already_accepted' });

    // The whole chain verifies.
    const final = await getVerifiedChain(db, request.id);
    expect(final.verification.ok).toBe(true);
    const types = final.rows.map((r) => r.type);
    expect(types).toContain('decision.accepted');
  });

  it('persisting anchors block approve until judged; persist re-asserts into next event', async () => {
    const { request } = await baseCreate();
    await reviewAndReject(request.id);

    // v2 that IGNORES the correction (same offending sentence).
    const v2 = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: V1 + '\n\nP.S. New unrelated line.',
    });
    expect(v2.classifications).toMatchObject({ persisting: 1 });

    const { rows } = await getVerifiedChain(db, request.id);
    expect(rows.map((r) => r.type)).toContain('correction.persisting');

    await claim(db, request.id, fx.userId);
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(true);
    expect(gate.reasons.join(' ')).toContain('the model ignored them');

    // Re-assert and reject again → outgoing carries it.
    const versionRow = v2.version;
    const anns = await outgoingCorrections(db, request.id);
    expect(anns.length).toBe(1);
    await markPersisting(db, request.id, anns[0].annotation_id, versionRow.id);
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'reject_corrections',
    });
    expect(shipped.status).toBe('rejected');
  });

  it('orphaned anchors block approve until retired; last-round reject ships and flags', async () => {
    const { request } = await baseCreate();
    await reviewAndReject(request.id); // round 1 → rejected

    // v2 deletes the whole paragraph → orphan.
    const v2content = V1.replace(
      "\n\nWe sincerely apologize for the interruption, but our 60-day goodwill window makes this the best tool you'll ever use.",
      ''
    );
    const v2 = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: v2content,
    });
    expect(v2.classifications).toMatchObject({ orphaned: 1 });

    await claim(db, request.id, fx.userId);
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    let gate = await approveGate(db, request.id, fx.userId);
    expect(gate.reasons.join(' ')).toContain('re-pin or retire');

    const out = await outgoingCorrections(db, request.id);
    // Orphans are not in the outgoing set — retire the annotation with reason.
    const chain = await getVerifiedChain(db, request.id);
    const annEvent = chain.rows.find((r) => r.type === 'annotation.created')!;
    await retire(db, {
      requestId: request.id,
      annotationId: (annEvent.payload as any).annotation_id,
      userId: fx.userId,
      reason: 'Paragraph removed entirely — moot',
    });
    gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);

    // Round budget: round 2 with budget 3 — reject twice more to hit it.
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'still weak',
      startPos: 0,
      endPos: 8,
    });
    await ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_corrections' });
    const v3 = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: v2content + '\n\nAnother pass.',
    });
    expect(v3.request.round).toBe(3);
    await claim(db, request.id, fx.userId);
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'fail',
      });
    }
    const last = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'reject_rerun',
    });
    expect(last.status).toBe('rejected');
    const after = await db.query.reviewRequests.findFirst({
      where: (t, { eq }) => eq(t.id, request.id),
    });
    expect(after?.budgetExhaustedAt).toBeInstanceOf(Date);

    await expect(
      ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_rerun' })
    ).rejects.toMatchObject({ code: 'round_budget_exceeded' });
  });
});

const ORPHAN_V2 = V1.replace(
  "\n\nWe sincerely apologize for the interruption, but our 60-day goodwill window makes this the best tool you'll ever use.",
  ''
);

async function scoreAllPass(requestId: string) {
  for (const cid of fx.criterionIds) {
    await setCriterionVerdict(db, {
      requestId,
      criterionId: cid,
      userId: fx.userId,
      verdict: 'pass',
    });
  }
}

async function round2Orphan() {
  const { request } = await baseCreate();
  const ann = await reviewAndReject(request.id);
  const v2 = await submitVersion(db, {
    projectId: fx.projectId,
    customerRequestId: request.customerRequestId,
    contentMd: ORPHAN_V2,
  });
  expect(v2.classifications).toMatchObject({ orphaned: 1 });
  await claim(db, request.id, fx.userId);
  await scoreAllPass(request.id);
  return { request, v2, annotationId: ann.id };
}

async function round2Persisting() {
  const { request } = await baseCreate();
  const ann = await reviewAndReject(request.id);
  const v2 = await submitVersion(db, {
    projectId: fx.projectId,
    customerRequestId: request.customerRequestId,
    contentMd: V1 + '\n\nP.S. New unrelated line.',
  });
  expect(v2.classifications).toMatchObject({ persisting: 1 });
  await claim(db, request.id, fx.userId);
  await scoreAllPass(request.id);
  return { request, v2, annotationId: ann.id };
}

async function expectResolvedOneTruth(annotationId: string, versionId: string) {
  const ann = await db.query.annotations.findFirst({
    where: (t, { eq }) => eq(t.id, annotationId),
  });
  expect(ann?.resolvedAt).toBeInstanceOf(Date);
  const st = await db.query.anchorStates.findFirst({
    where: (t, { and, eq }) => and(eq(t.annotationId, annotationId), eq(t.versionId, versionId)),
  });
  expect(st?.confirmation).toBe('res');
}

/**
 * VOBO-273. Jana: Resolve and C on a prior comment must unblock approve
 * without Retire. These must fail on current staging (orphaned rows ignore
 * confirmation and resolved_at).
 */
describe('VOBO-273: resolve/C on prior comments unblocks approve', () => {
  it('orphan + C: approveGate opens and ship(approve) succeeds without retire', async () => {
    const { request, v2, annotationId } = await round2Orphan();
    await confirmResolution(db, request.id, annotationId, v2.version.id);
    await expectResolvedOneTruth(annotationId, v2.version.id);

    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);
    expect(gate.reasons.join(' ')).not.toMatch(/orphan/i);

    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
      acknowledgeInterstitials: true,
    });
    expect(shipped.status).toBe('accepted');
  });

  it('orphan + comment Resolve: same as C (the Jana failure)', async () => {
    const { request, v2, annotationId } = await round2Orphan();
    await resolveComment(db, request.id, annotationId, fx.userId);
    await expectResolvedOneTruth(annotationId, v2.version.id);

    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);
    expect(gate.reasons.join(' ')).not.toMatch(/orphan/i);

    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
      acknowledgeInterstitials: true,
    });
    expect(shipped.status).toBe('accepted');
  });

  it('orphan with no human confirm still blocks; reason names Resolve/C; retire still unblocks', async () => {
    const { request, annotationId } = await round2Orphan();

    const blocked = await approveGate(db, request.id, fx.userId);
    expect(blocked.blocked).toBe(true);
    expect(blocked.reasons.join(' ')).toMatch(/orphan/i);
    expect(blocked.reasons.join(' ')).toMatch(/resolve|\bC\b/i);

    await retire(db, {
      requestId: request.id,
      annotationId,
      userId: fx.userId,
      reason: 'Paragraph removed — moot',
    });
    const after = await approveGate(db, request.id, fx.userId);
    expect(after.blocked).toBe(false);
  });

  it('persisting, unconfirmed, still blocks with the ignored-them copy', async () => {
    const { request } = await round2Persisting();
    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(true);
    expect(gate.reasons.join(' ')).toContain('the model ignored them');
  });

  it('persisting + C: reviewer accepted the miss, approve is allowed', async () => {
    const { request, v2, annotationId } = await round2Persisting();
    await confirmResolution(db, request.id, annotationId, v2.version.id);

    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);

    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
      acknowledgeInterstitials: true,
    });
    expect(shipped.status).toBe('accepted');
  });

  it('round 1: an unresolved new comment still blocks; Resolve still unblocks', async () => {
    const { request } = await baseCreate();
    await claim(db, request.id, fx.userId);
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'Apology boilerplate.',
      startPos: V1.indexOf('We sincerely apologize'),
      endPos: V1.indexOf('ever use.') + 'ever use.'.length,
    });
    await scoreAllPass(request.id);

    const blocked = await approveGate(db, request.id, fx.userId);
    expect(blocked.blocked).toBe(true);
    expect(blocked.reasons.join(' ')).toContain('new comment');

    const chain = await getVerifiedChain(db, request.id);
    const annEvent = chain.rows.find((r) => r.type === 'annotation.created')!;
    await resolveComment(db, request.id, (annEvent.payload as { annotation_id: string }).annotation_id, fx.userId);

    const open = await approveGate(db, request.id, fx.userId);
    expect(open.blocked).toBe(false);
  });
});

async function round2OrphanUnscored() {
  const { request } = await baseCreate();
  const ann = await reviewAndReject(request.id);
  const v2 = await submitVersion(db, {
    projectId: fx.projectId,
    customerRequestId: request.customerRequestId,
    contentMd: ORPHAN_V2,
  });
  expect(v2.classifications).toMatchObject({ orphaned: 1 });
  await claim(db, request.id, fx.userId);
  return { request, v2, annotationId: ann.id };
}

async function versionCount(requestId: string) {
  const rows = await db.query.artifactVersions.findMany({
    where: (t, { eq }) => eq(t.requestId, requestId),
  });
  return rows.length;
}

/**
 * VOBO-282. Human rewrite is the accepted artifact, verbatim. Leftover
 * annotation gates are skipped; unscored criteria are not.
 */
describe('VOBO-282: approve_edited accepts verbatim and skips leftover gates', () => {
  it('overrides leftover orphans after criteria are scored', async () => {
    const { request } = await round2OrphanUnscored();
    await scoreAllPass(request.id);
    const body = 'Human rewrite of the whole letter.';
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: body,
    });
    expect(shipped.status).toBe('accepted');
    expect(shipped.sealedHash).toBe(contentHash(body));

    const row = await db.query.reviewRequests.findFirst({
      where: (t, { eq }) => eq(t.id, request.id),
    });
    expect(row?.status).toBe('accepted');
    expect(row?.acceptedHash).toBe(contentHash(body));

    const human = await db.query.artifactVersions.findFirst({
      where: (t, { eq }) => eq(t.id, row!.acceptedVersionId!),
    });
    expect(human?.humanAuthored).toBe(true);
    expect(human?.authorKind).toBe('human');
    expect(human?.contentMd).toBe(body);
    expect(shipped.decision.versionId).toBe(human!.id);

    const { rows } = await getVerifiedChain(db, request.id);
    const accepted = rows.find((r) => r.type === 'decision.accepted')!;
    expect((accepted.payload as { accepted_version: number }).accepted_version).toBe(
      human!.versionNumber
    );
    expect((accepted.payload as { sealed_hash: string }).sealed_hash).toBe(contentHash(body));
  });

  it('approve_edited without scores is 422 criteria_unscored', async () => {
    const { request } = await round2OrphanUnscored();
    await expect(
      ship(db, {
        requestId: request.id,
        userId: fx.userId,
        kind: 'approve_edited',
        editedContentMd: 'Human rewrite of the whole letter.',
      })
    ).rejects.toMatchObject({ status: 422, code: 'criteria_unscored' });
    const row = await db.query.reviewRequests.findFirst({
      where: (t, { eq }) => eq(t.id, request.id),
    });
    expect(row?.status).toBe('claimed');
  });

  it('overrides persisting with no human confirmation', async () => {
    const { request } = await baseCreate();
    await reviewAndReject(request.id);
    await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: V1 + '\n\nP.S. New unrelated line.',
    });
    await claim(db, request.id, fx.userId);
    await scoreAllPass(request.id);
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: 'Fixed by a human.',
    });
    expect(shipped.status).toBe('accepted');
  });

  it('seals the submitted markdown including inner whitespace', async () => {
    const { request } = await round2OrphanUnscored();
    await scoreAllPass(request.id);
    const body = 'Hello  \n\tworld';
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: body,
    });
    expect(shipped.sealedHash).toBe(contentHash(body));
    const row = await db.query.reviewRequests.findFirst({
      where: (t, { eq }) => eq(t.id, request.id),
    });
    const human = await db.query.artifactVersions.findFirst({
      where: (t, { eq }) => eq(t.id, row!.acceptedVersionId!),
    });
    expect(human?.contentMd).toBe(body);
  });

  it('refuses empty or whitespace-only body; status stays open', async () => {
    const { request } = await round2OrphanUnscored();
    await expect(
      ship(db, {
        requestId: request.id,
        userId: fx.userId,
        kind: 'approve_edited',
        editedContentMd: '   \n',
      })
    ).rejects.toMatchObject({ status: 422, code: 'edited_content_required' });
    const row = await db.query.reviewRequests.findFirst({
      where: (t, { eq }) => eq(t.id, request.id),
    });
    expect(row?.status).toBe('claimed');
  });

  it('second approve_edited is 409 and does not add a version', async () => {
    const { request } = await round2OrphanUnscored();
    await scoreAllPass(request.id);
    await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: 'First human take.',
    });
    const n = await versionCount(request.id);
    await expect(
      ship(db, {
        requestId: request.id,
        userId: fx.userId,
        kind: 'approve_edited',
        editedContentMd: 'Second take.',
      })
    ).rejects.toMatchObject({ status: 409, code: 'terminal_status' });
    expect(await versionCount(request.id)).toBe(n);
  });

  it('accepts on the last policy round', async () => {
    const { request } = await round2OrphanUnscored();
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'still weak',
      startPos: 0,
      endPos: 8,
    });
    await scoreAllPass(request.id);
    await ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_corrections' });
    const v3 = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: ORPHAN_V2 + '\n\nAnother pass.',
    });
    expect(v3.request.round).toBe(3);
    await claim(db, request.id, fx.userId);
    await scoreAllPass(request.id);
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: 'Human close on round 3.',
    });
    expect(shipped.status).toBe('accepted');
  });

  it('accepts after budgetExhaustedAt and drops off the failing list; reject stays 422', async () => {
    const { request } = await round2OrphanUnscored();
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'still weak',
      startPos: 0,
      endPos: 8,
    });
    await scoreAllPass(request.id);
    await ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_corrections' });
    await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: ORPHAN_V2 + '\n\nAnother pass.',
    });
    await claim(db, request.id, fx.userId);
    await scoreAllPass(request.id);
    await ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_rerun' });
    const flagged = await db.query.reviewRequests.findFirst({
      where: (t, { eq }) => eq(t.id, request.id),
    });
    expect(flagged?.budgetExhaustedAt).toBeInstanceOf(Date);

    await expect(
      ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_rerun' })
    ).rejects.toMatchObject({ code: 'round_budget_exceeded' });

    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: 'Human close after the wall.',
    });
    expect(shipped.status).toBe('accepted');

    const listed = await listFailingRequests(db, { queueId: fx.queueId });
    expect(listed.map((r) => r.id)).not.toContain(request.id);

    await expect(
      ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_rerun' })
    ).rejects.toMatchObject({ code: 'terminal_status' });
  });
});

/**
 * VOBO-284. Resolve is a terminal state for the correction object.
 * Outgoing payload must not re-ship a row the reviewer marked done.
 */
describe('VOBO-284: Resolve is terminal for comments and versioned corrections', () => {
  it('comment Resolve unblocks approve and drops the id from outgoing', async () => {
    const { request, annotationId } = await round2Orphan();
    await resolveComment(db, request.id, annotationId, fx.userId);

    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);
    const out = await outgoingCorrections(db, request.id);
    expect(out.map((r) => r.annotation_id)).not.toContain(annotationId);
  });

  it('compare C sets resolved_at and drops the id from outgoing', async () => {
    const { request, v2, annotationId } = await round2Orphan();
    await confirmResolution(db, request.id, annotationId, v2.version.id);
    await expectResolvedOneTruth(annotationId, v2.version.id);

    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(false);
    const out = await outgoingCorrections(db, request.id);
    expect(out.map((r) => r.annotation_id)).not.toContain(annotationId);
  });

  it('no human end state still blocks; reason names Resolve/C', async () => {
    const { request } = await round2Orphan();
    const gate = await approveGate(db, request.id, fx.userId);
    expect(gate.blocked).toBe(true);
    expect(gate.reasons.join(' ')).toMatch(/resolve|\bC\b/i);
  });

  it('a resolved re-pin is not in the outgoing payload', async () => {
    const { request, v2, annotationId } = await round2Orphan();
    await repin(db, {
      requestId: request.id,
      annotationId,
      versionId: v2.version.id,
      userId: fx.userId,
      newQuote: ORPHAN_V2.slice(0, 8),
      newStartPos: 0,
      newEndPos: 8,
    });
    await confirmResolution(db, request.id, annotationId, v2.version.id);

    const out = await outgoingCorrections(db, request.id);
    expect(out.map((r) => r.annotation_id)).not.toContain(annotationId);
  });

  it('Retire still succeeds after Resolve; Approve already worked', async () => {
    const { request, annotationId } = await round2Orphan();
    await resolveComment(db, request.id, annotationId, fx.userId);
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
      acknowledgeInterstitials: true,
    });
    expect(shipped.status).toBe('accepted');
    await retire(db, {
      requestId: request.id,
      annotationId,
      userId: fx.userId,
      reason: 'drop from history',
    });
  });
});

describe('VOBO-289: Accept seals a chosen older version', () => {
  async function round2WithOpenComment() {
    const { request } = await baseCreate();
    const v1 = await db.query.artifactVersions.findFirst({
      where: and(eq(artifactVersions.requestId, request.id), eq(artifactVersions.versionNumber, 1)),
    });
    expect(v1).toBeTruthy();
    await reviewAndReject(request.id);
    await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: V2_FIXES_ONE,
    });
    await claim(db, request.id, fx.userId);
    const start = V2_FIXES_ONE.indexOf('rare tool');
    await addComment(db, {
      requestId: request.id,
      userId: fx.userId,
      body: 'Still a superlative.',
      startPos: start,
      endPos: start + 'rare tool'.length,
    });
    return { request, v1: v1! };
  }

  it('Accept of v1 on round 2 with an open leftover does not seal', async () => {
    const { request } = await round2Orphan();
    const v1 = await db.query.artifactVersions.findFirst({
      where: and(eq(artifactVersions.requestId, request.id), eq(artifactVersions.versionNumber, 1)),
    });
    expect(v1).toBeTruthy();
    await expect(
      ship(db, {
        requestId: request.id,
        userId: fx.userId,
        kind: 'approve',
        acceptedVersionId: v1!.id,
      })
    ).rejects.toMatchObject({ code: 'approve_blocked' });
    const [row] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(row.status).toBe('claimed');
    expect(row.acceptedVersionId).toBeNull();
  });

  it('Accept of v1 after leftover is resolved seals v1', async () => {
    const { request, v2, annotationId } = await round2Orphan();
    const v1 = await db.query.artifactVersions.findFirst({
      where: and(eq(artifactVersions.requestId, request.id), eq(artifactVersions.versionNumber, 1)),
    });
    expect(v1).toBeTruthy();
    await confirmResolution(db, request.id, annotationId, v2.version.id);
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
      acceptedVersionId: v1!.id,
      acknowledgeInterstitials: true,
    });
    expect(shipped.status).toBe('accepted');
    expect(shipped.sealedHash).toBe(v1!.contentHash);
    expect(shipped.decision.versionId).toBe(v1!.id);
    const [row] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(row.acceptedVersionId).toBe(v1!.id);
    expect(row.acceptedHash).toBe(v1!.contentHash);

    const { rows } = await getVerifiedChain(db, request.id);
    const accepted = rows.find((r) => r.type === 'decision.accepted')!;
    expect((accepted.payload as { accepted_version: number }).accepted_version).toBe(1);
    expect((accepted.payload as { sealed_hash: string }).sealed_hash).toBe(v1!.contentHash);
  });

  it('unscored criteria still block Accept of v1', async () => {
    const { request, v1 } = await round2WithOpenComment();
    await expect(
      ship(db, {
        requestId: request.id,
        userId: fx.userId,
        kind: 'approve',
        acceptedVersionId: v1.id,
      })
    ).rejects.toMatchObject({ code: 'criteria_unscored' });
  });

  it('Reject ignores acceptedVersionId and still needs corrections', async () => {
    const { request, v1 } = await round2WithOpenComment();
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'reject_corrections',
      acceptedVersionId: v1.id,
    });
    expect(shipped.status).toBe('rejected');
    const [row] = await db
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, request.id));
    expect(row.acceptedVersionId).toBeNull();
  });
});

describe('queue: ranking, claim race, lease expiry, SLA', () => {
  it('two concurrent claims — exactly one wins', async () => {
    const { request } = await baseCreate();
    const results = await Promise.allSettled([
      claim(db, request.id, fx.userId),
      claim(db, request.id, 'u_other'),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled').length;
    // The loser sees claim_race (lease exists) or not_claimable (status
    // already flipped) depending on commit timing — both are correct.
    const races = results.filter(
      (r) =>
        r.status === 'rejected' &&
        ['claim_race', 'not_claimable'].includes((r.reason as ApiProblem).code)
    ).length;
    expect(wins).toBe(1);
    expect(races).toBe(1);
  });

  it('ranking: sticky regeneration outranks earlier SLA; rationale serialized', async () => {
    const a = await baseCreate({ customerRequestId: 'r/a', title: 'A' });
    const b = await baseCreate({ customerRequestId: 'r/b', title: 'B' });
    // Make B a sticky regeneration for our user.
    await reviewAndReject(b.request.id);
    await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: 'r/b',
      contentMd: V2_FIXES_ONE,
    });
    const rows = await rankedQueue(db, fx.queueId, fx.userId);
    expect(rows[0].request.id).toBe(b.request.id);
    expect(rows[0].sticky).toBe(true);
    expect(rows[0].rankRationale).toContain('sticky');
    expect(rows.find((r) => r.request.id === a.request.id)).toBeTruthy();
  });

  it('expired lease returns the request to open', async () => {
    const { request } = await baseCreate();
    await claim(db, request.id, fx.userId);
    // Force-expire.
    const { leases } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(leases)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(leases.requestId, request.id));
    const n = await expireLeases(db);
    expect(n).toBe(1);
    const { reviewRequests } = await import('@/lib/db/schema');
    const after = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, request.id),
    });
    expect(after!.status).toBe('open');
  });

  it('SLA timeout applies fail-closed → escalated with flagged event', async () => {
    await truncateAll();
    fx = await createFixtures({ slaMinutes: 1, slaFailMode: 'fail_closed' });
    const { request } = await baseCreate();
    const { reviewRequests } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(reviewRequests)
      .set({ slaDueAt: new Date(Date.now() - 1000) })
      .where(eq(reviewRequests.id, request.id));
    const n = await applySlaTimeouts(db);
    expect(n).toBe(1);
    const after = await db.query.reviewRequests.findFirst({
      where: eq(reviewRequests.id, request.id),
    });
    expect(after!.status).toBe('escalated');
    const { rows } = await getVerifiedChain(db, request.id);
    const t = rows.find((r) => r.type === 'sla.timeout')!;
    expect((t.payload as any).flagged_unreviewed).toBe(true);
  });
});
