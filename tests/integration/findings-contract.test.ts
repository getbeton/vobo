import { readFileSync } from 'fs';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { createReview } from '@/lib/core/requests';
import { ingestFindings } from '@/lib/findings/ingest';
import { confirmFinding, dismissFinding } from '@/lib/findings/triage';
import { readFindings } from '@/lib/findings/read';
import { createProducer } from '@/lib/findings/producers';
import { ship } from '@/lib/core/verdict';
import { setCriterionVerdict } from '@/lib/core/annotations';
import { reviewRequests, artifactVersions, machineFindings, criteriaVerdicts } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { canEnterTraining } from '@/lib/judge/tenancy';
import { spanOverlap } from '@/lib/judge/agreement';

const BODY = `Subject: quick question about your review stack

Hi Dana, saw your team ships weekly.

We sincerely apologize for the interruption.`;

let fx: Fixtures;
let producerId: string;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  fx = await createFixtures();
  const created = await createProducer(db, {
    projectId: fx.projectId,
    name: 'test-producer',
    slug: 'test-producer',
  });
  producerId = created.producer.id;
});

async function seedRequest() {
  const { request } = await createReview(db, {
    projectId: fx.projectId,
    queueSlug: 'q',
    customerRequestId: 'pico/c1/acme/dana/seq1',
    title: 'Dana — seq 1',
    contentMd: BODY,
  });
  const version = await db.query.artifactVersions.findFirst({
    where: eq(artifactVersions.requestId, request.id),
  });
  return { request, version: version! };
}

describe('VOBO-48 MachineFinding contract', () => {
  it('posts a valid finding as untriaged and replays the same idempotency key', async () => {
    const { request, version } = await seedRequest();
    const quote = 'We sincerely apologize for the interruption.';
    const first = await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'batch-1',
      findings: [
        {
          criterion: 'voice',
          selector: { quote },
          evidence: quote,
          note: 'Apology opener is banned.',
        },
      ],
    });
    expect(first.replayed).toBe(false);
    expect(first.findings[0].triage).toBe('untriaged');
    expect(first.findings[0].startPos).toBe(BODY.indexOf(quote));

    const again = await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'batch-1',
      findings: [
        {
          criterion: 'voice',
          selector: { quote },
          evidence: quote,
          note: 'Apology opener is banned.',
        },
      ],
    });
    expect(again.replayed).toBe(true);
    expect(again.ids).toEqual(first.ids);
    const all = await db.select().from(machineFindings);
    expect(all).toHaveLength(1);
  });

  it('round-trips structuralAddress and omits it when absent', async () => {
    const { request, version } = await seedRequest();
    const quote = 'ships weekly';
    const res = await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'addr',
      findings: [
        {
          criterion: 'factual',
          selector: { quote },
          structuralAddress: { container: 'body', blockId: 'p2', ordinal: 0 },
          evidence: quote,
          note: 'ok',
        },
      ],
    });
    expect(res.findings[0].structuralContainer).toBe('body');
    expect(res.findings[0].structuralBlockId).toBe('p2');
    expect(res.findings[0].structuralOrdinal).toBe(0);

    const plain = await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'no-addr',
      findings: [
        {
          criterion: 'subject',
          selector: { quote: 'Subject: quick question' },
          evidence: 'Subject: quick question',
          note: 'ok',
        },
      ],
    });
    expect(plain.findings[0].structuralContainer).toBeNull();
  });

  it('rejects an unresolvable selector with 422 and writes nothing', async () => {
    const { request, version } = await seedRequest();
    await expect(
      ingestFindings(db, {
        requestId: request.id,
        versionId: version.id,
        producerId,
        idempotencyKey: 'bad',
        findings: [
          {
            criterion: 'voice',
            selector: { quote: 'this text is not in the artifact' },
            evidence: 'x',
            note: 'x',
          },
        ],
      })
    ).rejects.toMatchObject({ status: 422, code: 'unresolvable_selector' });
    const all = await db.select().from(machineFindings);
    expect(all).toHaveLength(0);
  });

  it('rejects findings on an accepted request', async () => {
    const { request, version } = await seedRequest();
    for (const criterionId of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    await ship(db, { requestId: request.id, userId: fx.userId, kind: 'approve' });
    await expect(
      ingestFindings(db, {
        requestId: request.id,
        versionId: version.id,
        producerId,
        idempotencyKey: 'late',
        findings: [
          {
            criterion: 'voice',
            selector: { quote: 'ships weekly' },
            evidence: 'ships weekly',
            note: 'late',
          },
        ],
      })
    ).rejects.toMatchObject({ status: 409, code: 'already_accepted' });
  });

  it('confirm marks the policy criterion Pass', async () => {
    const { request, version } = await seedRequest();
    const quote = 'We sincerely apologize for the interruption.';
    const posted = await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'c',
      findings: [
        { criterion: 'voice', passed: true, selector: { quote }, evidence: quote, note: 'voice is fine' },
      ],
    });
    const res = await confirmFinding(db, { findingId: posted.ids[0], userId: fx.userId });
    expect(res.verdict).toBe('pass');
    expect(res.finding.triage).toBe('confirmed');
    const human = await db
      .select()
      .from(criteriaVerdicts)
      .where(eq(criteriaVerdicts.versionId, version.id));
    expect(human.some((v) => v.verdict === 'pass' && v.userId === fx.userId)).toBe(true);
  });

  it('decline marks the policy criterion Fail', async () => {
    const { request, version } = await seedRequest();
    const quote = 'We sincerely apologize for the interruption.';
    const posted = await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'd',
      findings: [
        { criterion: 'voice', passed: false, selector: { quote }, evidence: quote, note: 'banned' },
      ],
    });
    const res = await dismissFinding(db, { findingId: posted.ids[0], userId: fx.userId });
    expect(res.verdict).toBe('fail');
    const human = await db
      .select()
      .from(criteriaVerdicts)
      .where(eq(criteriaVerdicts.versionId, version.id));
    expect(human.some((v) => v.verdict === 'fail' && v.userId === fx.userId)).toBe(true);
  });

  it('machine booleans count as scored so approve is not blocked by untriaged rows', async () => {
    const { request, version } = await seedRequest();
    const quote = 'We sincerely apologize for the interruption.';
    await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'gate',
      findings: fx.criterionIds.map((_, i) => ({
        criterion: i === 0 ? 'voice' : 'factual',
        passed: true,
        selector: { quote },
        evidence: quote,
        note: 'ok',
      })),
    });
    const decision = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve',
    });
    expect(decision.status).toBe('accepted');
  });

  it('reviewer read on a blind request returns no findings and no run metadata', async () => {
    const { request, version } = await seedRequest();
    await db
      .update(reviewRequests)
      .set({ judgeBlind: true })
      .where(eq(reviewRequests.id, request.id));
    const quote = 'We sincerely apologize for the interruption.';
    await ingestFindings(db, {
      requestId: request.id,
      versionId: version.id,
      producerId,
      idempotencyKey: 'blind',
      findings: [{ criterion: 'voice', selector: { quote }, evidence: quote, note: 'banned' }],
    });
    const reviewer = await readFindings(db, {
      requestId: request.id,
      versionId: version.id,
      audience: 'reviewer',
    });
    expect(reviewer.withheld).toBe(true);
    expect(reviewer.findings).toEqual([]);
    expect(reviewer.run).toBeNull();

    const admin = await readFindings(db, {
      requestId: request.id,
      versionId: version.id,
      audience: 'admin',
    });
    expect(admin.withheld).toBe(false);
    expect(admin.findings).toHaveLength(1);
  });

  it('does not derive a decision from judgeOverallScore', () => {
    const src = readFileSync('lib/core/verdict.ts', 'utf8');
    expect(src).not.toMatch(/judgeOverallScore/);
    expect(src).not.toMatch(/judge_overall_score/);
  });

  it('tenancy is a plan switch, not a boolean flag', () => {
    expect(canEnterTraining('cloud_paid')).toBe(true);
    expect(canEnterTraining('cloud_free')).toBe(true);
    expect(canEnterTraining('enterprise')).toBe(false);
    expect(canEnterTraining('self_host')).toBe(false);
    const src = readFileSync('lib/judge/tenancy.ts', 'utf8');
    expect(src).toMatch(/switch \(plan\)/);
    expect(src).not.toMatch(/trainingEnabled/);
  });

  it('span overlap threshold is a named constant', () => {
    expect(spanOverlap({ startPos: 0, endPos: 10 }, { startPos: 5, endPos: 15 })).toBe(0.5);
  });
});
