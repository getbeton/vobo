/**
 * Four-state pull contract (ARD §9, §38.4, §57.1).
 *
 * Consumers keep no local cursor. They read status before they touch anything.
 * `awaiting_version` is derived: rejected *and* reopened. A consumer that
 * polls only that filter still sees a late-critical reopen.
 */

export const AWAITING_VERSION_STATUSES = ['rejected', 'reopened'] as const;

export function isAwaitingVersion(status: string): boolean {
  return status === 'rejected' || status === 'reopened';
}

/** True while status is `reopened` — the prior acceptance may already have shipped. */
export function alreadyShipped(status: string): boolean {
  return status === 'reopened';
}

export const REOPEN_EVENT_TYPE = 'request.reopened_by_late_finding';

/**
 * The meter is the review request, not the round and not the acceptance
 * (ARD §25.1.2). A reopen is a round inside the same request and consumes
 * no extra unit (§38.4).
 */
export function billableUnits(requestCount: number): number {
  return requestCount;
}

/** Agent-facing /integrate copy. One scroll, no marketing chrome (ARD §49.3). */
export const INTEGRATE_COPY = `# Vobo /integrate — the pull contract

This page is the loop. One scroll. No marketing. Written for a model that will
drive HTTP or MCP.

## Two methods

- create review — POST /api/v1/reviews, MCP request_review. First generation.
  Idempotent upsert on your request_id. A retry never duplicates.
- submit version — POST /api/v1/versions, MCP submit_version. Every regeneration.
  404 on an unknown id. Never an implicit create. Identical content is a no-op.

Ids belong to you and must be deterministic.

## Four states

A consumer with no server pulls. Read status before you touch anything.

1. accepted — terminal for this round, not for the request. Do not regenerate.
   Keep the cursor moving. The request can still reopen.
2. reopened — a late critical finding reopened an acceptance. Treat as
   awaiting_version plus already_shipped: true. The artifact may already be in
   production. Branch on that flag. Do not treat it as an ordinary reject.
3. open (also claimed, held_blind, awaiting_signature) — in flight. Skip.
   Do not regenerate.
4. awaiting_version — the work list. GET /reviews?awaiting_version=true returns
   every request that needs a new version: rejected and reopened. A consumer
   that polls only this filter still observes a reopen.

reopened is filterable (status=reopened) and appears in the changed_since
stream. A consumer that stops on accepted and never handles reopened will not
learn that what it shipped came back.

Last-round escalate is not awaiting_version. Do not submit a version against
an escalated request.

## Pull

- GET /api/v1/reviews?queue=&status=&awaiting_version=true&changed_since=<event id>
- GET /api/v1/review?request_id=
- GET /api/v1/corrections?request_id=
- GET /api/v1/cursor and PUT /api/v1/cursor — server-side cursor per API key.

MCP tools with full-loop parity: request_review, submit_version, list_reviews,
get_review, get_corrections, get_cursor, set_cursor.

## Billing

One review request is one billable unit. Rounds and reopens inside it are free.
A reopen consumes no extra unit.

## Events

Reopen appends request.reopened_by_late_finding. The original decision.accepted
event stands, unaltered. The reopen payload carries already_shipped and the
finding that caused it. The sealed content hash is not unsealed.
`;
