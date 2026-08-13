import { randomBytes, createHash } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './drizzle';
import {
  user as userTable,
  workspaces,
  workspaceMembers,
  invitations,
  projects,
  queues,
  policyVersions,
  criteria,
  apiKeys,
  webhookEndpoints,
  reviewRequests,
  artifactVersions,
  annotations as annotationsTable,
  anchorStates,
  versionResponses,
  events,
  webhookDeliveries,
  repinHistory,
  criteriaVerdicts,
  decisions,
  leases,
  requestTags,
  activityLogs,
} from './schema';
import { DEFAULT_POLICY } from '@/lib/core/policy';
import { publishQueuePolicy } from '@/lib/core/policy-store';
import { createReview, submitVersion } from '@/lib/core/requests';
import { claim, applySlaTimeouts } from '@/lib/core/queue';
import { addComment, resolveComment, setCriterionVerdict } from '@/lib/core/annotations';
import { ship, repin, retire, confirmResolution } from '@/lib/core/verdict';

/**
 * Demo seed — a workspace with one of everything, for a screencast.
 *
 * Everything here goes through the real services (createReview, claim,
 * addComment, ship, submitVersion, repin), never straight INSERTs into the
 * event tables. So the hash chains verify, the anchor states are what the
 * matcher actually decided, and the metrics on the entity pages are computed
 * from real rows. A demo built on hand-written rows would show a chain badge
 * that means nothing.
 *
 *   npm run db:seed:demo
 *
 * Idempotent-ish: it refuses to run twice against the same workspace, because
 * a second pass would double every metric. Use RESET_DEMO=1 to clear the demo
 * project first.
 */

const SUBJECT = '## Email 1 — quick question about your evidence stack';

const V1 = `${SUBJECT}

Hi Dana, saw Acme shipped two systematic reviews last quarter.

We sincerely apologize for the interruption, but our platform is the best-in-class solution for evidence synthesis and will revolutionize how your team works.

We have helped companies like Pfizer and Novartis cut screening time by 90%.

Worth a quick 15-minute call next week?`;

/** Fixes the apology and the superlative; leaves the invented customers alone. */
const V2 = `${SUBJECT}

Hi Dana, saw Acme shipped two systematic reviews last quarter.

Two reviews a quarter usually means your screeners are the bottleneck, not your searchers.

We have helped companies like Pfizer and Novartis cut screening time by 90%.

Worth a quick 15-minute call next week?`;

/** Fixes everything, and rewrites the closing paragraph past recognition. */
const V3 = `${SUBJECT}

Hi Dana, saw Acme shipped two systematic reviews last quarter.

Two reviews a quarter usually means your screeners are the bottleneck, not your searchers.

Teams your size typically dual-screen 4,000 abstracts per review. Ours cuts the second pass, not the first — the audit trail stays intact for the regulator.

Open to a look at the screening step?`;

const CLEAN = `${SUBJECT.replace('evidence stack', 'trial recruitment')}

Hi Marcus, your last two protocols both listed sites in Ohio and Michigan.

Recruitment across two states usually means duplicate screening logs, which is where sponsors lose the audit trail.

We keep one log per subject across sites, so the monitor sees a single history.

Worth a look at the log format?`;

const SUPPORT_DRAFT = `## Reply to ticket 4821 — "export is stuck"

Hi Priya,

Thanks so much for reaching out!!! I completely understand your frustration.

Your export is stuck because the job queue was backed up. It should work now.

Let me know if there's anything else I can help with!`;

const SUPPORT_FIXED = `## Reply to ticket 4821 — "export is stuck"

Hi Priya,

Your export failed because the job ran out of memory on a 2.1M-row file, not because the queue was backed up.

We have re-run it in chunks; the file is in your downloads now. Exports above 1M rows will chunk automatically from Thursday.

If it stalls again, send us the job id and we will trace it.`;

const EMAIL_RUBRIC = [
  ['voice', 'Voice: direct, no marketing tone'],
  ['subject', 'Subject line follows the subject rules'],
  ['no-signature', 'No signatures in cold copy'],
  ['warm-followup', 'Warm-thread style on follow-ups'],
  ['no-dupes', 'No cross-sequence duplicate proof points'],
  ['persona', 'Persona-specific relevance'],
  ['factual', 'Claims match the dossier'],
] as const;

const SUPPORT_RUBRIC = [
  ['accurate', 'The diagnosis is the real cause'],
  ['actionable', 'Tells the customer what happens next'],
  ['tone', 'Plain, no exclamation marks, no apology theatre'],
  ['no-promise', 'Promises nothing engineering has not shipped'],
] as const;

const TEAM = [
  { name: 'Mara Kim', email: 'mara@betonlabs.dev', role: 'reviewer' as const },
  { name: 'Jonas Størm', email: 'jonas@betonlabs.dev', role: 'reviewer' as const },
  { name: 'Ana López', email: 'ana@betonlabs.dev', role: 'operator' as const },
];

function findAll(haystack: string, needle: string) {
  const start = haystack.indexOf(needle);
  if (start < 0) throw new Error(`demo seed: anchor text not found: ${needle.slice(0, 40)}…`);
  return { start, end: start + needle.length };
}

async function makeUser(name: string, email: string) {
  const existing = await db.query.user.findFirst({ where: eq(userTable.email, email) });
  if (existing) return existing;
  const [row] = await db
    .insert(userTable)
    .values({
      id: `u_demo_${randomBytes(6).toString('hex')}`,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return row;
}

async function makeQueue(
  projectId: string,
  slug: string,
  name: string,
  rubric: ReadonlyArray<readonly [string, string]>,
  ownerId: string,
  opts: { slaMinutes?: number | null; overrideBudget?: number } = {}
) {
  const made: Record<string, string> = {};
  for (const environment of ['production', 'test'] as const) {
    const [queue] = await db
      .insert(queues)
      .values({
        projectId,
        name,
        slug,
        environment,
        policyOverrides: opts.overrideBudget ? { roundBudget: opts.overrideBudget } : {},
      })
      .returning();
    const [pv] = await db
      .insert(policyVersions)
      .values({
        queueId: queue.id,
        version: 1,
        config: {
          ...DEFAULT_POLICY,
          roundBudget: opts.overrideBudget ?? 3,
          slaMinutes: environment === 'production' ? (opts.slaMinutes ?? null) : null,
        },
        createdBy: ownerId,
      })
      .returning();
    await db.update(queues).set({ activePolicyVersionId: pv.id }).where(eq(queues.id, queue.id));
    await db.insert(criteria).values(
      rubric.map(([key, title], i) => ({ queueId: queue.id, key, title, position: i }))
    );
    made[environment] = queue.id;
  }
  return made;
}

async function scoreAll(requestId: string, queueId: string, userId: string, failing: string[] = []) {
  const rows = await db
    .select()
    .from(criteria)
    .where(and(eq(criteria.queueId, queueId), isNull(criteria.archivedAt)));
  for (const c of rows) {
    await setCriterionVerdict(db, {
      requestId,
      criterionId: c.id,
      userId,
      verdict: failing.includes(c.key) ? 'fail' : 'pass',
    });
  }
}


/**
 * Tear the demo back down. Deletes every review artifact in the workspace and
 * the entities this script adds, leaving the base seed's workspace, owner and
 * pico-cold-email queue in place. Deliberately explicit about order rather than
 * relying on cascades — most of these FKs have none, and a half-deleted graph
 * is worse than a refusal.
 */
async function resetDemo(workspaceId: number) {
  const owned = await db.select().from(projects).where(eq(projects.workspaceId, workspaceId));
  const projectIds = owned.map((p) => p.id);
  if (projectIds.length === 0) return;

  const reqs = await db.select().from(reviewRequests);
  const mine = reqs.filter((r) => projectIds.includes(r.projectId)).map((r) => r.id);
  const allQueues = await db.select().from(queues);
  const queueIds = allQueues.filter((q) => projectIds.includes(q.projectId)).map((q) => q.id);

  for (const requestId of mine) {
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.requestId, requestId));
    for (const v of versions) {
      await db.delete(anchorStates).where(eq(anchorStates.versionId, v.id));
      await db.delete(versionResponses).where(eq(versionResponses.versionId, v.id));
    }
    const evs = await db.select().from(events).where(eq(events.requestId, requestId));
    for (const e of evs) await db.delete(webhookDeliveries).where(eq(webhookDeliveries.eventId, e.id));
    await db.delete(events).where(eq(events.requestId, requestId));
    // repin_history hangs off the annotation, not the request.
    const anns = await db
      .select({ id: annotationsTable.id })
      .from(annotationsTable)
      .where(eq(annotationsTable.requestId, requestId));
    for (const a of anns) {
      await db.delete(repinHistory).where(eq(repinHistory.annotationId, a.id));
      await db.delete(anchorStates).where(eq(anchorStates.annotationId, a.id));
    }
    await db.delete(criteriaVerdicts).where(eq(criteriaVerdicts.requestId, requestId));
    await db.delete(decisions).where(eq(decisions.requestId, requestId));
    await db.delete(leases).where(eq(leases.requestId, requestId));
    await db.delete(requestTags).where(eq(requestTags.requestId, requestId));
    await db.delete(annotationsTable).where(eq(annotationsTable.requestId, requestId));
    await db.delete(artifactVersions).where(eq(artifactVersions.requestId, requestId));
    await db
      .update(reviewRequests)
      .set({ acceptedVersionId: null })
      .where(eq(reviewRequests.id, requestId));
    await db.delete(reviewRequests).where(eq(reviewRequests.id, requestId));
  }

  // Queues and projects the demo added; the base pico-cold-email queue stays.
  const doomedQueues = allQueues.filter(
    (q) => queueIds.includes(q.id) && q.slug !== 'pico-cold-email'
  );
  for (const q of doomedQueues) {
    await db.update(queues).set({ activePolicyVersionId: null }).where(eq(queues.id, q.id));
    await db.delete(criteria).where(eq(criteria.queueId, q.id));
    await db.delete(policyVersions).where(eq(policyVersions.queueId, q.id));
    await db.delete(queues).where(eq(queues.id, q.id));
  }

  const acmeProject = owned.find((p) => p.slug === 'acme');
  if (acmeProject) {
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.projectId, acmeProject.id));
    await db.delete(apiKeys).where(eq(apiKeys.projectId, acmeProject.id));
    await db.delete(projects).where(eq(projects.id, acmeProject.id));
  }

  for (const member of TEAM) {
    const u = await db.query.user.findFirst({ where: eq(userTable.email, member.email) });
    if (!u) continue;
    await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, u.id));
    await db.delete(activityLogs).where(eq(activityLogs.userId, u.id));
    await db.delete(userTable).where(eq(userTable.id, u.id));
  }
  await db.delete(invitations).where(eq(invitations.email, 'tom@betonlabs.dev'));
}

async function seedDemo() {
  const owner = await db.query.user.findFirst({
    where: eq(userTable.email, process.env.SEED_EMAIL || 'v@getbeton.ai'),
  });
  if (!owner) throw new Error('Run `npm run db:seed` first — no owner account found.');

  const membership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, owner.id),
  });
  if (!membership) throw new Error('Owner has no workspace — run `npm run db:seed` first.');
  const workspaceId = membership.workspaceId;

  const already = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, workspaceId), eq(projects.slug, 'acme')),
  });
  if (already && !process.env.RESET_DEMO) {
    console.log('Demo data already present. Re-run with RESET_DEMO=1 to rebuild it.');
    return;
  }
  if (process.env.RESET_DEMO) await resetDemo(workspaceId);

  // ── Workspace: defaults, teammates, a pending invite ───────────────────────
  await db
    .update(workspaces)
    .set({ policyDefaults: { roundBudget: 3, blindN: 0, slaMinutes: null } })
    .where(eq(workspaces.id, workspaceId));

  const team: Record<string, string> = {};
  for (const member of TEAM) {
    const u = await makeUser(member.name, member.email);
    team[member.email] = u.id;
    const has = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.userId, u.id), eq(workspaceMembers.workspaceId, workspaceId)),
    });
    if (!has) {
      await db
        .insert(workspaceMembers)
        .values({ userId: u.id, workspaceId, role: member.role });
    }
  }
  const pendingInvite = await db.query.invitations.findFirst({
    where: eq(invitations.email, 'tom@betonlabs.dev'),
  });
  if (!pendingInvite) {
    await db.insert(invitations).values({
      workspaceId,
      email: 'tom@betonlabs.dev',
      role: 'reviewer',
      invitedBy: owner.id,
    });
  }
  const mara = team['mara@betonlabs.dev'];
  const jonas = team['jonas@betonlabs.dev'];
  const ana = team['ana@betonlabs.dev'];

  // ── A second project, so the workspace page is not a single row ────────────
  const [acme] = await db
    .insert(projects)
    .values({ workspaceId, name: 'Acme Pipelines', slug: 'acme' })
    .returning();

  const pico = await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, workspaceId), eq(projects.slug, 'pico')),
  });
  if (!pico) throw new Error('PICO project missing — run `npm run db:seed` first.');

  // Second queue in PICO (so the project page lists more than one), and a
  // queue in Acme with a policy OVERRIDE so the queue page shows both states.
  const trials = await makeQueue(pico.id, 'pico-trial-sites', 'pico-trial-sites', EMAIL_RUBRIC, owner.id, {
    slaMinutes: 3 * 24 * 60,
  });
  const support = await makeQueue(acme.id, 'support-replies', 'support-replies', SUPPORT_RUBRIC, owner.id, {
    slaMinutes: 4 * 60,
    overrideBudget: 2,
  });
  await publishQueuePolicy(db, support.production, owner.id);

  const picoQueue = await db.query.queues.findFirst({
    where: and(eq(queues.projectId, pico.id), eq(queues.environment, 'production')),
  });
  if (!picoQueue) throw new Error('pico-cold-email production queue missing.');

  const [acmeKey] = await db.insert(apiKeys).values({
    projectId: acme.id,
    name: 'acme-support-bot',
    keyHash: createHash('sha256').update(`demo-${randomBytes(8).toString('hex')}`).digest('hex'),
    keyPrefix: 'vobo_sk_demo',
  }).returning();
  void acmeKey;

  await db.insert(webhookEndpoints).values({
    projectId: acme.id,
    url: 'https://acme.example/hooks/vobo',
    secret: `whsec_${randomBytes(16).toString('base64url')}`,
    eventTypes: ['decision.accepted', 'decision.rejected', 'correction.persisting'],
    active: true,
  });

  const created: string[] = [];
  const mk = async (
    queueSlug: string,
    projectId: string,
    id: string,
    title: string,
    contentMd: string,
    priority = 3
  ) => {
    const { request } = await createReview(db, {
      projectId,
      queueSlug,
      environment: 'production',
      customerRequestId: id,
      title,
      contentMd,
      prompt:
        'Voice: direct, no marketing tone, Simplified Technical English. Subject ≤ 6 words. ' +
        'No signature. Every claim must trace to the dossier.',
      source:
        'Acme Corp — 40-person CRO, 12 systematic reviews a year. Dana Liu, Head of Evidence, ' +
        'joined 2024 from a sponsor side. Two reviews shipped last quarter (source: their blog).',
      priority,
      authorLabel: 'claude-code',
      pipelineRunId: `demo/${queueSlug}`,
      tags: ['campaign:demo', 'account:acme.com'],
    });
    created.push(request.id);
    return request;
  };

  // ── 1. Accepted on the first round — the good case, hash-sealed ────────────
  const clean = await mk('pico-cold-email', pico.id, 'demo/acme/marcus/seq-a', 'Marcus Webb — Acme — trial sites', CLEAN, 2);
  await claim(db, clean.id, mara);
  await scoreAll(clean.id, picoQueue.id, mara);
  await ship(db, { requestId: clean.id, userId: mara, kind: 'approve' });

  // ── 2. The full three-round story: reject → persisting → repin → accept ────
  const story = await mk('pico-cold-email', pico.id, 'demo/acme/dana/seq-a', 'Dana Liu — Acme — sequence A', V1, 1);
  await claim(db, story.id, mara);

  const apology = findAll(V1, 'We sincerely apologize for the interruption');
  const invented = findAll(V1, 'We have helped companies like Pfizer and Novartis cut screening time by 90%.');
  const closing = findAll(V1, 'Worth a quick 15-minute call next week?');

  await addComment(db, {
    requestId: story.id,
    userId: mara,
    body: 'Apology opener plus a superlative. Both are on the banned list.',
    expected: 'Open on the reader’s situation. No superlatives, no apology.',
    startPos: apology.start,
    endPos: apology.end,
  });
  await addComment(db, {
    requestId: story.id,
    userId: mara,
    body: 'These customer names are not in the dossier. Naming them is an NDA problem, not a style one.',
    expected: 'Cite a number we can source, or cut the sentence.',
    startPos: invented.start,
    endPos: invented.end,
  });
  await addComment(db, {
    requestId: story.id,
    userId: jonas,
    body: 'A 15-minute call is a big first ask for someone who has never heard of us.',
    expected: 'Ask for a look at one artifact instead of calendar time.',
    startPos: closing.start,
    endPos: closing.end,
  });
  await scoreAll(story.id, picoQueue.id, mara, ['voice', 'factual']);
  await ship(db, { requestId: story.id, userId: mara, kind: 'reject_corrections' });

  // v2 fixes one, ignores another → a PERSISTING correction, loudly.
  await submitVersion(db, {
    projectId: pico.id,
    customerRequestId: 'demo/acme/dana/seq-a',
    contentMd: V2,
    authorLabel: 'claude-code',
  });

  await claim(db, story.id, mara);
  await scoreAll(story.id, picoQueue.id, mara, ['factual']);
  await ship(db, { requestId: story.id, userId: mara, kind: 'reject_corrections' });

  // v3 fixes it and rewrites the closing paragraph past recognition → orphan.
  const v3 = await submitVersion(db, {
    projectId: pico.id,
    customerRequestId: 'demo/acme/dana/seq-a',
    contentMd: V3,
    authorLabel: 'claude-code',
  });

  // Re-pin the orphaned closing comment onto the new ask — human wins.
  const orphaned = await db.query.annotations.findFirst({
    where: and(eq(annotationsTable.requestId, story.id), eq(annotationsTable.bornRound, 1)),
  });
  const openTo = findAll(V3, 'Open to a look at the screening step?');
  const allAnns = await db
    .select()
    .from(annotationsTable)
    .where(eq(annotationsTable.requestId, story.id));
  const closingAnn = allAnns.find((a) => a.quote.startsWith('Worth a quick')) ?? orphaned!;
  await repin(db, {
    requestId: story.id,
    annotationId: closingAnn.id,
    versionId: v3.version.id,
    userId: jonas,
    newQuote: 'Open to a look at the screening step?',
    newStartPos: openTo.start,
    newEndPos: openTo.end,
  });

  // The approve gate refuses while any anchor is unjudged, which is the whole
  // point of it — so the demo shows a human actually judging them: the removed
  // claim is retired, the re-pinned ask is confirmed resolved.
  const atV3 = await db
    .select()
    .from(annotationsTable)
    .where(and(eq(annotationsTable.requestId, story.id), isNull(annotationsTable.retiredAt)));
  const inventedAnn = atV3.find((a) => a.quote.startsWith('We have helped companies'));
  if (inventedAnn) {
    await retire(db, {
      requestId: story.id,
      annotationId: inventedAnn.id,
      userId: mara,
      reason: 'The sentence is gone from v3 — nothing left to point at.',
    });
  }
  await confirmResolution(db, story.id, closingAnn.id, v3.version.id);

  await claim(db, story.id, mara);
  await scoreAll(story.id, picoQueue.id, mara);
  await ship(db, {
    requestId: story.id,
    userId: mara,
    kind: 'approve',
    acknowledgeInterstitials: true,
  });

  // ── 3. Waiting on the pipeline: rejected, awaiting version ────────────────
  const awaiting = await mk('pico-cold-email', pico.id, 'demo/acme/priya/seq-b', 'Priya Raman — Acme — sequence B', V1, 2);
  await claim(db, awaiting.id, jonas);
  await addComment(db, {
    requestId: awaiting.id,
    userId: jonas,
    body: 'Same invented customers as the Dana sequence. This is the pattern, not a one-off.',
    expected: 'Cut both names.',
    startPos: invented.start,
    endPos: invented.end,
  });
  await scoreAll(awaiting.id, picoQueue.id, jonas, ['factual']);
  await ship(db, { requestId: awaiting.id, userId: jonas, kind: 'reject_corrections' });

  // ── 4. Escalated — needs an operator's ruling ─────────────────────────────
  const escalated = await mk('pico-cold-email', pico.id, 'demo/acme/dana/seq-c', 'Dana Liu — Acme — pricing bump', V2, 1);
  await claim(db, escalated.id, jonas);
  await scoreAll(escalated.id, picoQueue.id, jonas, ['no-dupes']);
  await ship(db, {
    requestId: escalated.id,
    userId: jonas,
    kind: 'escalate',
    reason: 'Third touch this month for this contact. Cadence call is above my pay grade.',
  });

  // ── 5. Regenerate-from-scratch rejection ─────────────────────────────────
  const rerun = await mk('pico-cold-email', pico.id, 'demo/acme/sofia/seq-a', 'Sofia Marín — Acme — sequence A', V1, 3);
  await claim(db, rerun.id, mara);
  await scoreAll(rerun.id, picoQueue.id, mara, ['persona', 'voice', 'factual']);
  await ship(db, { requestId: rerun.id, userId: mara, kind: 'reject_rerun' });

  // ── 6. Claimed right now, mid-review, with an unanswered comment ──────────
  const inFlight = await mk('pico-cold-email', pico.id, 'demo/acme/ken/seq-a', 'Ken Adeyemi — Acme — sequence A', V1, 2);
  await claim(db, inFlight.id, mara);
  await addComment(db, {
    requestId: inFlight.id,
    userId: mara,
    body: 'Still deciding whether this opener is specific enough. Leaving it open.',
    expected: 'Name the protocol, not the company.',
    startPos: apology.start,
    endPos: apology.end,
  });

  // ── 7. Untouched, waiting in the queue ───────────────────────────────────
  await mk('pico-cold-email', pico.id, 'demo/acme/lena/seq-a', 'Lena Fischer — Acme — sequence A', CLEAN, 4);
  await mk('pico-trial-sites', pico.id, 'demo/acme/site-42/intro', 'Site 42 — investigator intro', CLEAN, 3);

  // ── 8. Human-edited acceptance in another project (approve_edited) ────────
  const supportReq = await createReview(db, {
    projectId: acme.id,
    queueSlug: 'support-replies',
    environment: 'production',
    customerRequestId: 'demo/support/4821',
    title: 'Ticket 4821 — export is stuck',
    contentMd: SUPPORT_DRAFT,
    prompt: 'Answer the actual cause. Plain tone. Promise nothing unshipped.',
    source: 'Ticket 4821. Job 91f3 failed: OOM on a 2.1M-row export. Chunking ships Thursday.',
    priority: 1,
    authorLabel: 'support-agent',
    pipelineRunId: 'demo/support',
  });
  await claim(db, supportReq.request.id, ana);
  const wrongCause = findAll(SUPPORT_DRAFT, 'because the job queue was backed up');
  const supportNote = await addComment(db, {
    requestId: supportReq.request.id,
    userId: ana,
    body: 'This is not what happened. The job hit an out-of-memory error on a 2.1M-row file.',
    expected: 'State the real cause and what we did about it.',
    startPos: wrongCause.start,
    endPos: wrongCause.end,
  });
  // Correcting it by hand answers the comment, so it is resolved before the
  // verdict — the gate refuses to approve over an open one, by design.
  await resolveComment(db, supportReq.request.id, supportNote.id, ana);
  await scoreAll(supportReq.request.id, support.production, ana, ['accurate', 'tone']);
  await ship(db, {
    requestId: supportReq.request.id,
    userId: ana,
    kind: 'approve_edited',
    editedContentMd: SUPPORT_FIXED,
    acknowledgeInterstitials: true,
  });

  // ── 9. An SLA that has already blown, so the alert feed has a real entry ──
  const overdue = await createReview(db, {
    projectId: acme.id,
    queueSlug: 'support-replies',
    environment: 'production',
    customerRequestId: 'demo/support/4790',
    title: 'Ticket 4790 — refund not received',
    contentMd: SUPPORT_DRAFT.replace('4821', '4790'),
    prompt: 'Answer the actual cause. Plain tone.',
    source: 'Ticket 4790. Refund issued 6 days ago, bank posting delay.',
    priority: 1,
    authorLabel: 'support-agent',
  });
  await db
    .update(reviewRequests)
    .set({ slaDueAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
    .where(eq(reviewRequests.id, overdue.request.id));
  const timedOut = await applySlaTimeouts(db);

  const requestCount = await db.select().from(reviewRequests);
  const versionCount = await db.select().from(artifactVersions);

  console.log('Demo seed complete.');
  console.log(`  workspace     ${workspaceId} (+3 teammates, 1 pending invite)`);
  console.log(`  projects      PICO Outbound, Acme Pipelines`);
  console.log(`  queues        pico-cold-email, pico-trial-sites, support-replies (prod + test each)`);
  console.log(`  requests      ${requestCount.length} across open / claimed / rejected / accepted / escalated`);
  console.log(`  versions      ${versionCount.length} (one request runs v1 → v2 → v3)`);
  console.log(`  sla timeouts  ${timedOut}`);
  console.log('');
  console.log('  For the screencast: /queue shows the ranked list, demo/acme/dana/seq-a has the');
  console.log('  three-round story (persisting → orphaned → re-pinned → accepted), and');
  console.log('  /requests/<that id> shows the verified chain.');
}

seedDemo()
  .catch((error) => {
    console.error('Demo seed failed:', error);
    const q = (error as { query?: string; parameters?: unknown[] }).query;
    if (q) console.error('  query:', q);
    process.exit(1);
  })
  .finally(() => process.exit(0));
