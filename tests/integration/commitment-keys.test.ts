import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db, client, ensureMigrated, truncateAll, createFixtures, Fixtures } from './harness';
import { artifactVersions, workspaces } from '@/lib/db/schema';
import { createReview, submitVersion } from '@/lib/core/requests';
import { claim } from '@/lib/core/queue';
import { setCriterionVerdict } from '@/lib/core/annotations';
import { ship } from '@/lib/core/verdict';
import { eraseScope } from '@/lib/core/erasure';
import { expireRequestContent } from '@/lib/core/expiry';
import { verifyAuditBundle } from '@/lib/core/audit-bundle';
import { buildRequestAuditBundle } from '@/lib/core/audit-export';
import { commitContent, deriveCommitmentKey } from '@/lib/core/commitment';
import { getVerifiedChain } from '@/lib/core/eventlog';

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

async function openRequest(customerRequestId: string, contentMd: string) {
  const created = await createReview(db, {
    projectId: fx.projectId,
    queueSlug: 'q',
    customerRequestId,
    title: customerRequestId,
    contentMd,
  });
  return created.request;
}

describe('VOBO-195 commitment keys', () => {
  it('stores an HKDF key and SHA-256(key || content), never a bare sha256', async () => {
    const body = 'Short artifact';
    const request = await openRequest('pico/commit/1', body);
    const [version] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, fx.workspaceId));

    expect(ws.rootKey).toMatch(/^[0-9a-f]{64}$/);
    expect(version.commitmentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(version.commitmentKey).toBe(
      deriveCommitmentKey(ws.rootKey, version.id, '')
    );
    expect(version.contentHash).toBe(commitContent(version.commitmentKey!, body));
    expect(version.contentHash).not.toBe(
      createHash('sha256').update(body, 'utf8').digest('hex')
    );

    const bundle = await buildRequestAuditBundle(db, request.id);
    expect(JSON.stringify(bundle)).not.toContain(ws.rootKey);
    expect(bundle.requests[0].artifacts[0].commitment_key).toBe(version.commitmentKey);
    expect(verifyAuditBundle(bundle).status).toBe('verified');
  });

  it('erasure destroys only the erased scope key and leaves the workspace root', async () => {
    const a = await openRequest('pico/erase/a', 'alpha');
    const b = await openRequest('pico/erase/b', 'beta');
    const [wsBefore] = await db.select().from(workspaces).where(eq(workspaces.id, fx.workspaceId));

    await eraseScope(db, {
      requestId: a.id,
      authorizingRequestId: 'gdpr-17-a',
      userId: fx.userId,
    });

    const [wsAfter] = await db.select().from(workspaces).where(eq(workspaces.id, fx.workspaceId));
    expect(wsAfter.rootKey).toBe(wsBefore.rootKey);

    const [erased] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, a.id));
    expect(erased.commitmentKey).toBeNull();
    expect(erased.keyDestroyedAt).toBeInstanceOf(Date);
    expect(erased.contentMd).toContain('authorised by gdpr-17-a');

    const [kept] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, b.id));
    expect(kept.commitmentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(kept.contentMd).toBe('beta');

    const erasedBundle = await buildRequestAuditBundle(db, a.id);
    expect(erasedBundle.requests[0].artifacts[0]).not.toHaveProperty('commitment_key');
    const erasedVerdict = verifyAuditBundle(erasedBundle);
    expect(erasedVerdict.status).toBe('intentionally_voided');
    expect(erasedVerdict.voids[0].authorizingRequestId).toBe('gdpr-17-a');

    const keptBundle = await buildRequestAuditBundle(db, b.id);
    expect(keptBundle.requests[0].artifacts[0].commitment_key).toBe(kept.commitmentKey);
    expect(verifyAuditBundle(keptBundle).status).toBe('verified');

    const chain = await getVerifiedChain(db, a.id);
    expect(chain.verification.ok).toBe(true);
    expect(chain.rows.map((r) => r.type)).toContain('scope.erased');
  });

  it('routine expiry purges bodies and keeps keys; a later erasure then voids', async () => {
    const request = await openRequest('pico/expire/1', 'retain-me');
    const [before] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    const liveKey = before.commitmentKey;
    expect(liveKey).toBeTruthy();

    await expireRequestContent(db, request.id);

    const [expired] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    expect(expired.commitmentKey).toBe(liveKey);
    expect(expired.keyDestroyedAt).toBeNull();
    expect(expired.contentPurgedAt).toBeInstanceOf(Date);
    expect(expired.contentMd).toContain('retention');
    expect(expired.contentMd).not.toContain('authorised by');

    const expiredBundle = await buildRequestAuditBundle(db, request.id);
    expect(expiredBundle.requests[0].artifacts[0].commitment_key).toBe(liveKey);
    expect(expiredBundle.requests[0].artifacts[0].content).toBeNull();
    expect(verifyAuditBundle(expiredBundle).status).toBe('verified');

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, fx.workspaceId));
    expect(commitContent(liveKey!, 'retain-me')).toBe(expired.contentHash);
    expect(deriveCommitmentKey(ws.rootKey, expired.id, '')).toBe(liveKey);

    await eraseScope(db, {
      requestId: request.id,
      authorizingRequestId: 'gdpr-after-expiry',
      userId: fx.userId,
    });

    const [voided] = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    expect(voided.commitmentKey).toBeNull();
    expect(voided.keyDestroyedAt).toBeInstanceOf(Date);

    const voidedBundle = await buildRequestAuditBundle(db, request.id);
    expect(voidedBundle.requests[0].artifacts[0]).not.toHaveProperty('commitment_key');
    expect(verifyAuditBundle(voidedBundle).status).toBe('intentionally_voided');
    expect(ws.rootKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('approve_edited seals a keyed commitment, not a bare hash', async () => {
    const request = await openRequest('pico/edit/1', 'draft');
    await claim(db, request.id, fx.userId);
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'pass',
      });
    }
    const edited = 'human-fixed';
    const shipped = await ship(db, {
      requestId: request.id,
      userId: fx.userId,
      kind: 'approve_edited',
      editedContentMd: edited,
    });
    expect(shipped.sealedHash).not.toBe(
      createHash('sha256').update(edited, 'utf8').digest('hex')
    );
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, request.id));
    const human = versions.find((v) => v.humanAuthored);
    expect(human).toBeTruthy();
    expect(shipped.sealedHash).toBe(commitContent(human!.commitmentKey!, edited));
  });

  it('idempotent submit still no-ops on identical bodies after keyed commitments', async () => {
    const request = await openRequest('pico/idem/1', 'v1');
    await claim(db, request.id, fx.userId);
    for (const cid of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: request.id,
        criterionId: cid,
        userId: fx.userId,
        verdict: 'fail',
      });
    }
    await ship(db, { requestId: request.id, userId: fx.userId, kind: 'reject_rerun' });
    const first = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: 'v2',
    });
    const again = await submitVersion(db, {
      projectId: fx.projectId,
      customerRequestId: request.customerRequestId,
      contentMd: 'v2',
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.version.id).toBe(first.version.id);
  });
});
