# Vobo MVP — what shipped

**Epic:** VOBO-1 · **Branch:** `feature/VOBO-1-mvp` · **PR:** getbeton/vobo#1 · **Date:** 2026-08-12

Vobo is a human-review station for AI pipeline output. A pipeline submits an artifact, a person
judges it against a rubric and anchors corrections on exact spans, and the pipeline pulls those
corrections back and regenerates. Every step is a signed event in a hash chain.

This document is the operator's view. The architecture rationale lives in
`docs/vobo-ard-2026-08-12.md`; the PICO integration in `docs/vobo-pico-email-pipeline-2026-08-12.md`.

---

## The loop

```
create review ──▶ [open] ──claim──▶ [claimed] ──verdict──▶ accepted   (terminal for the round)
                                                        ├─▶ rejected  (awaiting version)
                                                        └─▶ escalated (needs an operator)
       ▲                          ▲                          │
       │                          └── reopened ◀── late critical
       └───────────────── submit version ────────────────────┘
```

`accepted` is terminal for the round, not the request. A late critical finding
reopens it (`reopened` = `awaiting_version` plus `already_shipped`). See `/integrate`.

Two API methods, deliberately not one:

| Method | When | Behaviour |
|---|---|---|
| `create review` | first generation | idempotent upsert on the **customer's** request id — a retried session never duplicates |
| `submit version` | every regeneration | 404s on an unknown id (never an implicit create); identical-to-latest content is a no-op *before* any status gate |

Ids belong to the caller and are deterministic (`pico/<campaign>/<domain>/<contact>/<seq>`), which is
what makes both of those safe.

## What makes it different from a comment box

**Corrections are anchored, and they survive rewrites.** Every comment stores W3C dual selectors —
the quoted text with its prefix/suffix, *and* character offsets. When the next version arrives, each
anchor is re-classified:

| State | Meaning | Consequence |
|---|---|---|
| `resolved` | the flagged span is genuinely gone | drops out of the outgoing payload |
| `persisting` | the span survived the rewrite | **loud** — the model ignored a human |
| `orphaned` | the paragraph was rewritten past recognition | asks the reviewer to re-pin or retire |
| `repinned` | a human moved it | human judgment always wins over the matcher |

A human confirmation is never overwritten by the matcher. Performance: 50 anchors over a 46KB
artifact classify in ~41 ms (budget 500 ms, enforced by a test).

**Nothing is a silent mutation.** Every state change appends a hash-chained event
(`prev_hash → hash`); acceptance seals the content hash, so "what shipped" is provably what was
approved. The Timeline screen verifies the whole chain on load and says so.

**Policy is versioned.** Workspace defaults plus per-queue overrides resolve into one config that is
frozen as an immutable `policy_versions` row. A request stamps the active version at creation, so
changing the round budget today cannot retroactively change how yesterday's request was judged. A
no-op edit does not burn a version number.

## Screens

| Route | For | What it does |
|---|---|---|
| `/queue` | reviewer | ranked work (sticky → SLA → priority → FIFO) with the ranking rationale shown, claim/release with leases |
| `/review/[id]` | reviewer | the artifact, the prompt and dossier it is judged against, anchored comments with an **Expected** field, criteria pass/fail, the verdict gate |
| `/review/[id]/compare` | reviewer | side-by-side versions with the prior-findings rail — persists / re-pin / retire |
| `/requests`, `/requests/[id]` | anyone | the ledger: versions with hashes, every event, chain verification, the acceptance seal |
| `/admin`, `/admin/projects/[slug]`, `/admin/queues/[slug]` | operator, admin | yield and rounds-to-accept, members and roles, plan usage, policy defaults and per-queue overrides |

All of them are verbatim ports of the design prototype vendored at
`design/vobo-review-station.dc.html`. Read `design/README.md` before touching UI.

## Integrating a pipeline

Three ways in, same contract:

- **HTTP** — `/api/v1/reviews`, `/api/v1/versions`, `/api/v1/corrections`, `/api/v1/review`,
  `/api/v1/cursor`. Bearer key, project-scoped.
- **MCP** — `request_review`, `submit_version`, `list_reviews`, `get_review`, `get_corrections`,
  `get_cursor`, `set_cursor`. Full-loop parity: an agent can run the entire cycle over MCP.
- **Webhooks** — Standard Webhooks signing, retry ladder 10s/60s/180s, then a dead-letter queue.

Consumers with no server (a terminal agent) **pull**: `changed_since` takes an event-id cursor that
Vobo stores per API key, and `awaiting_version` is a derived flag (`rejected` **and** `reopened`).
The consumer keeps no local state, so two copies of the same agent on different machines cannot
drift. `/integrate` teaches the four-state loop: accepted, reopened, in-flight, awaiting_version.

## Operating it

- **Deploy**: `DEPLOY.md`. Staging is live at `vobo-web-staging.up.railway.app`; production is
  intentionally not spun up yet.
- **Two services**: `vobo-web` and `vobo-worker`. The worker delivers webhooks and runs the
  lease-expiry and SLA sweeps every 60s; all its state is in Postgres, so restarting it is safe.
- **Migrations** replay at container boot (`npm run boot`) before the app serves.
- **Storage** is BYO: S3 when configured, otherwise a local `.storage/` driver. Artifacts are
  content-addressed and the event log is mirrored as JSONL — a second, dumb read path that works
  even if Vobo is down.
- **Analytics** are off unless `POSTHOG_KEY` is set, and payloads are allow-listed: reviewed
  content, prompts, comment bodies and quotes never leave the deployment.

## Roles

`admin` (everything, manages members) → `operator` (rules on escalations, edits policy) →
`reviewer` (works the queue). `adjudicator` exists in the schema for blind-N review; there is no
adjudication UI in the MVP and `blindN` defaults to 0.

## Tests

51 across seven files. The ones that carry the most weight:

- `lib/anchoring/__tests__/classify.test.ts` — the classification matrix, calibrated against the
  prototype's own corpus
- `perf.test.ts` — the 500 ms budget
- `tests/integration/review-loop.test.ts` — the full loop at the service layer
- `tests/integration/policy-admin.test.ts` — versioning, inheritance, and that in-flight requests
  keep their stamped policy
- `tests/integration/dogfood-e2e.test.ts` — **the release gate**: the PICO loop driven over MCP as a
  stdio child process against the real route handlers and a real Postgres

## Known gaps

- No adjudication UI (blind-N is schema-only).
- Judge/pre-annotation shipped in VOBO-30. Enable it per queue; BYO key is `VOBO_JUDGE_OPENAI_API_KEY`.
- Markdown is the only artifact modality; CSV/image/code modalities are designed, not built.
- `get_review` returns versions and events but not anchor states; consumers read anchors through
  `get_corrections`.
- Production environment not created — see `DEPLOY.md` for why and how.

## Identity: Google meeting an earlier email/password account (VOBO-168)

One human, one user row. Google sign-in shipped after email/password, so the
two can meet — deliberately, in three places:

- **Normalisation.** Every address is trimmed and lowercased, at the sign-in
  and sign-up boundary and again in the user-create hook. Gmail's dots and
  `+tags` are **not** collapsed: that is one provider's convention, and other
  providers treat those as different people.
- **Linking.** `accountLinking` trusts Google, so signing in with Google as an
  address that already has a password attaches to the existing user — same
  workspace, same role, no second identity.
- **The unverified case.** Anyone can register an email/password account for an
  address they do not own; nothing proves ownership at signup. If the real owner
  then signs in with Google and we link the two, the squatter's password opens
  the owner's account. So when Google links into an account whose email was
  never verified, the unproven password credential is **revoked** and the
  address is marked verified — Google proved it, the password holder never did.
  The owner keeps the account and can set a new password. A verified password is
  left alone and both credentials keep working.

Pairs that already diverged before this shipped are merged with
`scripts/merge-users.mjs --keep <email|id> --merge <email|id>`, which is a
**dry-run by default** and re-points every reference — memberships, decisions,
annotations, criteria verdicts, repins, sticky reviewers, activity — before
retiring the losing row. Attribution is the reason it is a merge and not a
delete: a decision without an author stops answering "who accepted this", which
is the entire promise of the Timeline. Signed events are never rewritten; only
foreign keys move.
