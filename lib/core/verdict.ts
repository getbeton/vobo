import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  reviewRequests,
  artifactVersions,
  annotations,
  anchorStates,
  criteria,
  criteriaVerdicts,
  decisions,
  leases,
  repinHistory,
  machineFindings,
} from '@/lib/db/schema';
import { appendEvent, Db, DbOrTx } from './eventlog';
import { ApiProblem, getPolicyForRequest, insertCommittedVersion } from './requests';
import { untriagedFindings } from '@/lib/findings/read';
import { listEdits, workingContentMd, rejectDecisionCount } from './suggestions';

/**
 * Verdict state machine. Semantics are NORMATIVE from the design prototype's
 * DCLogic (approveGate / openVerdict / ship / applyConsequence) and ARD §6:
 * explicit verdicts, named gate reasons, outgoing payload rule, hash sealing.
 */

export type VerdictKind =
  | 'approve'
  | 'approve_edited'
  | 'reject_rerun'
  | 'reject_corrections'
  | 'escalate';

export interface GateResult {
  blocked: boolean;
  reasons: string[];
  /** Soft confirmations the UI shows as interstitials, not hard blocks. */
  interstitials: string[];
}

async function loadContext(tx: DbOrTx, requestId: string) {
  const request = await tx.query.reviewRequests.findFirst({
    where: eq(reviewRequests.id, requestId),
  });
  if (!request) throw new ApiProblem(404, 'request_not_found', 'Request not found');
  const version = await tx.query.artifactVersions.findFirst({
    where: and(
      eq(artifactVersions.requestId, requestId),
      eq(artifactVersions.versionNumber, request.round)
    ),
  });
  if (!version) throw new ApiProblem(500, 'version_missing', 'Current version missing');
  return { request, version };
}

/** Live (non-retired) annotations with their state on the current version. */
async function annotationStates(tx: DbOrTx, requestId: string, versionId: string) {
  return tx
    .select({ ann: annotations, state: anchorStates })
    .from(annotations)
    .leftJoin(
      anchorStates,
      and(eq(anchorStates.annotationId, annotations.id), eq(anchorStates.versionId, versionId))
    )
    .where(and(eq(annotations.requestId, requestId), isNull(annotations.retiredAt)));
}

/**
 * The approve gates, with the prototype's exact user-facing reasons.
 * On round 1 the compare-gates are vacuous (no prior anchors).
 */
export async function approveGate(
  tx: DbOrTx,
  requestId: string,
  userId: string
): Promise<GateResult> {
  const { request, version } = await loadContext(tx, requestId);
  const reasons: string[] = [];
  const interstitials: string[] = [];

  // All criteria must be scored (any verdict) for the current version.
  const activeCriteria = await tx
    .select()
    .from(criteria)
    .where(and(eq(criteria.queueId, request.queueId), isNull(criteria.archivedAt)));
  const scored = await tx
    .select()
    .from(criteriaVerdicts)
    .where(and(eq(criteriaVerdicts.versionId, version.id), eq(criteriaVerdicts.userId, userId)));
  const machineRows = await tx
    .select({ key: machineFindings.criterionKey })
    .from(machineFindings)
    .where(and(eq(machineFindings.versionId, version.id), isNull(machineFindings.purgedAt)));
  const humanIds = new Set(scored.map((s) => s.criterionId));
  const machineKeys = new Set(machineRows.map((m) => m.key));
  const unscored = activeCriteria.filter(
    (c) => !humanIds.has(c.id) && !machineKeys.has(c.key)
  ).length;
  if (unscored > 0) {
    reasons.push(`Score all criteria to proceed — ${unscored} left`);
  }

  const rows = await annotationStates(tx, requestId, version.id);

  const bornThisRound = rows.filter(
    (r) => r.ann.bornRound === request.round && !r.ann.resolvedAt
  );
  if (bornThisRound.length > 0) {
    reasons.push(`${bornThisRound.length} new comment(s) on this version — reject with corrections`);
  }

  if (request.round > 1) {
    const prior = rows.filter((r) => r.ann.bornRound < request.round && r.state);
    const persisting = prior.filter(
      (r) =>
        r.state!.state === 'persisting' &&
        r.state!.confirmation !== 'res' &&
        !isHumanResolved(r.ann, r.state)
    );
    if (persisting.length > 0) {
      reasons.push(`${persisting.length} correction(s) persisting — the model ignored them`);
    }
    const orphaned = prior.filter(
      (r) => r.state!.state === 'orphaned' && !isHumanResolved(r.ann, r.state)
    );
    if (orphaned.length > 0) {
      reasons.push(`${orphaned.length} orphaned anchor(s) — resolve (C), re-pin or retire`);
    }
    const repinnedUnjudged = prior.filter(
      (r) =>
        r.state!.state === 'repinned' &&
        !r.state!.confirmation &&
        !isHumanResolved(r.ann, r.state)
    );
    if (repinnedUnjudged.length > 0) {
      reasons.push(`${repinnedUnjudged.length} re-pinned anchor(s) unjudged — resolved or persists`);
    }
    const unconfirmedResolved = prior.filter(
      (r) =>
        r.state!.state === 'resolved' &&
        !r.state!.confirmation &&
        !isHumanResolved(r.ann, r.state)
    );
    if (unconfirmedResolved.length > 0) {
      interstitials.push(
        `${unconfirmedResolved.length} resolution(s) unconfirmed — approving records them as auto-confirmed`
      );
    }
  }

  return { blocked: reasons.length > 0, reasons, interstitials };
}

/** Outgoing corrections payload rule (prototype `outgoing()`). */
export async function outgoingCorrections(tx: DbOrTx, requestId: string) {
  const { request, version } = await loadContext(tx, requestId);
  const rows = await annotationStates(tx, requestId, version.id);
  const out = rows.filter((r) => {
    if (isHumanResolved(r.ann, r.state)) return false;
    if (r.ann.bornRound === request.round && !r.ann.resolvedAt) return true; // new
    if (!r.state) return false;
    if (r.state.state === 'persisting' && r.state.confirmation !== 'res') return true; // re-asserted
    if (r.state.state === 'repinned') return true;
    return false;
  });
  return out.map((r) => ({
    annotation_id: r.ann.id,
    body: r.ann.body,
    expected: r.ann.expected,
    quote: r.ann.quote,
    start: r.ann.startPos,
    end: r.ann.endPos,
    born_round: r.ann.bornRound,
    state: r.state?.state ?? 'new',
  }));
}

export interface ShipInput {
  requestId: string;
  userId: string;
  kind: VerdictKind;
  /** Required (≥4 chars) for escalate. */
  reason?: string;
  /** Approve despite interstitials (auto-confirm resolutions). */
  acknowledgeInterstitials?: boolean;
  /** For approve_edited: the human-corrected artifact content. */
  editedContentMd?: string;
  /** Ship despite untriaged machine findings. Recorded on the signed event. */
  overrideUntriagedFindings?: boolean;
  /** Approve of a chosen version (VOBO-290). Default is the current round. */
  acceptedVersionId?: string;
}

export async function ship(db: Db, input: ShipInput) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(reviewRequests)
      .where(eq(reviewRequests.id, input.requestId))
      .for('update');
    if (!locked) throw new ApiProblem(404, 'request_not_found', 'Request not found');
    if (locked.archivedAt) throw new ApiProblem(409, 'archived', 'Request is archived');
    if (locked.status === 'accepted')
      throw new ApiProblem(409, 'terminal_status', `Request is ${locked.status}`);
    const closingEscalated =
      locked.status === 'escalated' &&
      (input.kind === 'approve' || input.kind === 'approve_edited');
    if (locked.status === 'escalated' && !closingEscalated)
      throw new ApiProblem(409, 'terminal_status', `Request is ${locked.status}`);

    const { request, version } = await loadContext(tx, input.requestId);
    const policy = await getPolicyForRequest(tx, request.policyVersionId);

    const untriaged = await untriagedFindings(tx, request.id, version.id);

    const liveEdits = await listEdits(tx, request.id, version.id);
    if (liveEdits.some((r) => r.status === 'pending' || r.status === 'applied')) {
      throw new ApiProblem(
        422,
        'unsaved_suggestions',
        liveEdits.some((r) => r.status === 'pending')
          ? 'Accept or reject open suggestions first'
          : 'Save accepted suggestions before shipping a verdict'
      );
    }

    let chosenVersion = version;
    if (input.kind === 'approve' && input.acceptedVersionId && input.acceptedVersionId !== version.id) {
      const chosen = await tx.query.artifactVersions.findFirst({
        where: and(
          eq(artifactVersions.id, input.acceptedVersionId),
          eq(artifactVersions.requestId, request.id)
        ),
      });
      if (!chosen)
        throw new ApiProblem(422, 'version_not_on_request', 'Chosen version is not on this request');
      chosenVersion = chosen;
    }

    if (input.kind === 'approve_edited') {
      if (!input.editedContentMd || !input.editedContentMd.trim())
        throw new ApiProblem(422, 'edited_content_required', 'approve_edited requires the edited content');
    }

    const priorRejects = await rejectDecisionCount(tx, request.id);
    const thisRejectIsNth =
      input.kind === 'reject_corrections' || input.kind === 'reject_rerun'
        ? priorRejects + 1
        : 0;
    const atWall = thisRejectIsNth >= policy.roundBudget;
    let criteriaSkipped = false;

    if (input.kind === 'escalate') {
      if (!input.reason || input.reason.trim().length < 4)
        throw new ApiProblem(422, 'escalation_reason_required', 'Escalation reason is required');
    } else {
      const gate = await approveGate(tx, input.requestId, input.userId);
      const criteriaBlock = gate.reasons.find((r) => r.startsWith('Score all criteria'));
      if (criteriaBlock && !atWall)
        throw new ApiProblem(422, 'criteria_unscored', criteriaBlock);
      if (criteriaBlock && atWall) criteriaSkipped = true;

      if (input.kind === 'approve') {
        if (gate.blocked)
          throw new ApiProblem(422, 'approve_blocked', gate.reasons.join(' · '));
        if (gate.interstitials.length > 0 && !input.acknowledgeInterstitials)
          throw new ApiProblem(422, 'interstitial_unacknowledged', gate.interstitials.join(' · '));
      }

      if (input.kind === 'reject_corrections' || input.kind === 'reject_rerun') {
        if (locked.budgetExhaustedAt && locked.status !== 'escalated')
          throw new ApiProblem(
            422,
            'round_budget_exceeded',
            `This request already used the last policy round (${locked.round}/${policy.roundBudget})`
          );
        if (!atWall) {
          const out = await outgoingCorrections(tx, input.requestId);
          if (input.kind === 'reject_corrections' && out.length === 0)
            throw new ApiProblem(422, 'no_corrections', 'No corrections to send — use reject-rerun');
        }
      }
    }

    // approve_edited: the human's fix becomes the acceptance candidate version.
    // approve of a prior version: seal that hash (VOBO-290).
    let sealedVersionId = chosenVersion.id;
    let sealedHash = chosenVersion.contentHash;
    let acceptedVersionNumber = chosenVersion.versionNumber;
    if (input.kind === 'approve_edited') {
      const edited = input.editedContentMd!;
      const human = await insertCommittedVersion(tx, {
        requestId: request.id,
        versionNumber: request.round + 1,
        authorKind: 'human',
        authorLabel: 'human edit',
        contentMd: edited,
        humanAuthored: true,
      });
      sealedVersionId = human.id;
      sealedHash = human.contentHash;
      acceptedVersionNumber = human.versionNumber;
    }

    const outgoing =
      input.kind === 'reject_corrections' ? await outgoingCorrections(tx, input.requestId) : [];

    const [decision] = await tx
      .insert(decisions)
      .values({
        requestId: request.id,
        versionId: sealedVersionId,
        round: request.round,
        kind: input.kind,
        reason: input.reason,
        decidedBy: input.userId,
        sealedHash: input.kind.startsWith('approve') ? sealedHash : null,
      })
      .returning();

    // Auto-confirm unconfirmed resolutions on approve (recorded, per prototype).
    if (input.kind === 'approve' || input.kind === 'approve_edited') {
      await tx
        .update(anchorStates)
        .set({ confirmation: 'res', updatedAt: new Date() })
        .where(
          and(
            eq(anchorStates.versionId, version.id),
            eq(anchorStates.state, 'resolved'),
            isNull(anchorStates.confirmation)
          )
        );
    }

    const criteriaRows = await tx
      .select({
        key: criteria.key,
        verdict: criteriaVerdicts.verdict,
      })
      .from(criteriaVerdicts)
      .innerJoin(criteria, eq(criteria.id, criteriaVerdicts.criterionId))
      .where(
        and(eq(criteriaVerdicts.versionId, version.id), eq(criteriaVerdicts.userId, input.userId))
      );

    const basePayload = {
      customer_request_id: request.customerRequestId,
      round: request.round,
      decided_by: input.userId,
      policy_version_id: request.policyVersionId,
      criteria: criteriaRows,
      was_edited: input.kind === 'approve_edited',
      untriaged_override: Boolean(input.overrideUntriagedFindings),
      untriaged_finding_ids: untriaged.map((f) => f.id),
    };

    let newStatus: 'accepted' | 'rejected' | 'escalated';
    if (input.kind === 'approve' || input.kind === 'approve_edited') {
      newStatus = 'accepted';
      await tx
        .update(reviewRequests)
        .set({
          status: 'accepted',
          acceptedVersionId: sealedVersionId,
          acceptedHash: sealedHash,
          updatedAt: new Date(),
        })
        .where(eq(reviewRequests.id, request.id));
      await appendEvent(tx, request.id, 'decision.accepted', {
        ...basePayload,
        kind: input.kind,
        sealed_hash: sealedHash,
        accepted_version: acceptedVersionNumber,
      });
    } else if (input.kind === 'escalate') {
      newStatus = 'escalated';
      await tx
        .update(reviewRequests)
        .set({ status: 'escalated', updatedAt: new Date() })
        .where(eq(reviewRequests.id, request.id));
      await appendEvent(tx, request.id, 'decision.escalated', {
        ...basePayload,
        reason: input.reason,
        round_budget: policy.roundBudget,
      });
    } else {
      const at = new Date();
      if (atWall) {
        // Nth reject: end of the rewrite loop. Status is escalated so the
        // model does not send another version. Approve still closes it.
        newStatus = 'escalated';
        await tx
          .update(reviewRequests)
          .set({
            status: 'escalated',
            budgetExhaustedAt: locked.budgetExhaustedAt ?? at,
            budgetExhaustedBy: locked.budgetExhaustedBy ?? input.userId,
            updatedAt: at,
          })
          .where(eq(reviewRequests.id, request.id));
        await appendEvent(tx, request.id, 'decision.escalated', {
          ...basePayload,
          via: 'last_round_reject',
          kind: input.kind,
          reason: 'round_budget_exhausted',
          criteria_skipped: criteriaSkipped,
          corrections: outgoing,
          round_budget: policy.roundBudget,
        });
        if (!locked.budgetExhaustedAt) {
          await appendEvent(tx, request.id, 'request.budget_exhausted', {
            by: input.userId,
            round: request.round,
            round_budget: policy.roundBudget,
            kind: input.kind,
          });
        }
      } else {
        newStatus = 'rejected';
        await tx
          .update(reviewRequests)
          .set({
            status: 'rejected',
            stickyReviewerId: policy.stickyRegenerations ? input.userId : null,
            updatedAt: at,
          })
          .where(eq(reviewRequests.id, request.id));
        await appendEvent(tx, request.id, 'decision.rejected', {
          ...basePayload,
          kind: input.kind,
          corrections: outgoing,
        });
      }
      // Re-asserted persisting anchors are recorded as such.
      await tx
        .update(anchorStates)
        .set({ reasserted: true, updatedAt: new Date() })
        .where(
          and(
            eq(anchorStates.versionId, version.id),
            eq(anchorStates.state, 'persisting')
          )
        );
    }

    await tx.delete(leases).where(eq(leases.requestId, request.id));

    return { decision, status: newStatus, sealedHash: decision.sealedHash };
  });
}

// ---------------------------------------------------------------------------
// Compare-rail actions: confirm / persist / re-pin / retire (VOBO-22 backend)
// ---------------------------------------------------------------------------

/** Human Resolve / C wins over the stored classifier enum. History stays. */
export function isHumanResolved(
  ann: { resolvedAt: Date | null },
  state: { confirmation: 'res' | 'per' | null } | null | undefined
): boolean {
  return Boolean(ann.resolvedAt) || state?.confirmation === 'res';
}

/**
 * One write for both surfaces: comment-rail Resolve and compare C.
 * Classifier `state` is left as stored history.
 */
export async function markCorrectionResolved(
  tx: DbOrTx,
  input: { requestId: string; annotationId: string; versionId: string; userId?: string }
) {
  const ann = await tx.query.annotations.findFirst({
    where: and(eq(annotations.id, input.annotationId), eq(annotations.requestId, input.requestId)),
  });
  if (!ann) throw new ApiProblem(404, 'annotation_not_found', 'Annotation not found');

  await tx
    .update(annotations)
    .set({
      resolvedAt: ann.resolvedAt ?? new Date(),
      resolvedBy: ann.resolvedBy ?? input.userId ?? null,
    })
    .where(eq(annotations.id, ann.id));

  await tx
    .update(anchorStates)
    .set({ confirmation: 'res', updatedAt: new Date() })
    .where(and(eq(anchorStates.annotationId, ann.id), eq(anchorStates.versionId, input.versionId)));

  await appendEvent(tx, input.requestId, 'annotation.resolved', {
    annotation_id: ann.id,
    version_id: input.versionId,
    by: input.userId,
  });
}

export async function confirmResolution(
  db: Db,
  requestId: string,
  annotationId: string,
  versionId: string,
  userId?: string
) {
  await db.transaction(async (tx) => {
    await markCorrectionResolved(tx, { requestId, annotationId, versionId, userId });
  });
}

export async function markPersisting(db: Db, requestId: string, annotationId: string, versionId: string) {
  await db
    .update(anchorStates)
    .set({ confirmation: 'per', reasserted: true, updatedAt: new Date() })
    .where(and(eq(anchorStates.annotationId, annotationId), eq(anchorStates.versionId, versionId)));
}

export async function repin(
  db: Db,
  input: {
    requestId: string;
    annotationId: string;
    versionId: string;
    userId: string;
    newQuote: string;
    newStartPos: number;
    newEndPos: number;
  }
) {
  return db.transaction(async (tx) => {
    const ann = await tx.query.annotations.findFirst({
      where: eq(annotations.id, input.annotationId),
    });
    if (!ann) throw new ApiProblem(404, 'annotation_not_found', 'Annotation not found');
    const version = await tx.query.artifactVersions.findFirst({
      where: eq(artifactVersions.id, input.versionId),
    });
    if (!version || version.requestId !== input.requestId)
      throw new ApiProblem(404, 'version_not_found', 'Version not found on this request');
    const working = await workingContentMd(tx, input.requestId, version);
    if (
      input.newStartPos < 0 ||
      input.newEndPos > working.length ||
      input.newStartPos >= input.newEndPos
    )
      throw new ApiProblem(422, 'invalid_range', 'Re-pin range is outside the working artifact');
    const quote = working.slice(input.newStartPos, input.newEndPos);
    await tx.insert(repinHistory).values({
      annotationId: input.annotationId,
      versionId: input.versionId,
      oldQuote: ann.quote,
      oldStartPos: ann.startPos,
      oldEndPos: ann.endPos,
      newQuote: quote,
      newStartPos: input.newStartPos,
      newEndPos: input.newEndPos,
      userId: input.userId,
    });
    await tx
      .update(annotations)
      .set({ quote, startPos: input.newStartPos, endPos: input.newEndPos })
      .where(eq(annotations.id, input.annotationId));
    await tx
      .insert(anchorStates)
      .values({
        annotationId: input.annotationId,
        versionId: input.versionId,
        state: 'repinned',
        confidence: 'high',
        newQuote: quote,
        newStartPos: input.newStartPos,
        newEndPos: input.newEndPos,
      })
      .onConflictDoUpdate({
        target: [anchorStates.annotationId, anchorStates.versionId],
        set: {
          state: 'repinned',
          confidence: 'high',
          newQuote: quote,
          newStartPos: input.newStartPos,
          newEndPos: input.newEndPos,
          confirmation: null,
          updatedAt: new Date(),
        },
      });
    await appendEvent(tx, input.requestId, 'anchor.repinned', {
      annotation_id: input.annotationId,
      by: input.userId,
    });
  });
}

export async function retire(
  db: Db,
  input: { requestId: string; annotationId: string; userId: string; reason: string }
) {
  if (!input.reason || input.reason.trim().length < 2)
    throw new ApiProblem(422, 'retire_reason_required', 'Retire requires a reason');
  return db.transaction(async (tx) => {
    await tx
      .update(annotations)
      .set({ retiredAt: new Date(), retireReason: input.reason })
      .where(eq(annotations.id, input.annotationId));
    await appendEvent(tx, input.requestId, 'anchor.retired', {
      annotation_id: input.annotationId,
      reason: input.reason,
      by: input.userId,
    });
  });
}
