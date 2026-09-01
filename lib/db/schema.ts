import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  uuid,
  bigserial,
  jsonb,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const workspaceRoleEnum = pgEnum('workspace_role', [
  'admin',
  'operator',
  'reviewer',
  'adjudicator', // reserved; no adjudication UI in MVP
]);

export const workspacePlanEnum = pgEnum('workspace_plan', [
  'community',
  'cloud_free',
  'cloud_paid',
  'enterprise',
  'self_host',
]);

export const findingSeverityEnum = pgEnum('finding_severity', ['critical', 'minor']);

export const findingTriageEnum = pgEnum('finding_triage', [
  'untriaged',
  'confirmed',
  'dismissed',
  'suppressed',
]);

export const judgeRunStateEnum = pgEnum('judge_run_state', [
  'pending',
  'running',
  'completed',
  'failed',
  'not_sampled',
]);

export const queueEnvironmentEnum = pgEnum('queue_environment', [
  'test',
  'production',
]);

export const requestStatusEnum = pgEnum('request_status', [
  'open',
  'claimed',
  'held_blind', // reserved; blindN=0 in MVP policies
  'accepted',
  'rejected', // rejected and awaiting the next version
  'escalated',
  'reopened', // accepted, then a late critical; awaiting_version + already_shipped
]);

export const authorKindEnum = pgEnum('author_kind', ['model', 'human']);

export const manualEditStatusEnum = pgEnum('manual_edit_status', [
  'pending',
  'applied',
  'rejected',
]);

export const anchorStateEnum = pgEnum('anchor_state', [
  'new', // born this round
  'resolved',
  'persisting',
  'orphaned',
  'repinned',
]);

export const anchorConfidenceEnum = pgEnum('anchor_confidence', [
  'high',
  'med',
  'low',
]);

export const anchorConfirmationEnum = pgEnum('anchor_confirmation', [
  'res', // human confirmed resolved
  'per', // human marked persisting (re-asserts into next event)
]);

export const criterionVerdictEnum = pgEnum('criterion_verdict', [
  'pass',
  'fail',
  'na',
]);

export const decisionKindEnum = pgEnum('decision_kind', [
  'approve',
  'approve_edited',
  'reject_rerun',
  'reject_corrections',
  'escalate',
]);

export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'delivered', // 2xx received = acked
  'failed', // retrying
  'dead', // retries exhausted (DLQ)
]);

// ---------------------------------------------------------------------------
// Identity & tenancy (Workspace → Project → Queue)
// ---------------------------------------------------------------------------

// BetterAuth-managed tables (drizzle adapter). Column shapes follow the
// better-auth schema contract — do not add app columns here; app-level user
// data belongs in domain tables keyed by user.id.
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified')
    .$defaultFn(() => false)
    .notNull(),
  image: text('image'),
  createdAt: timestamp('created_at')
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => new Date())
    .notNull(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at').$defaultFn(() => new Date()),
});

export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
  // Policy defaults inherited by projects/queues (zod-validated JSON; the one
  // deliberate settings column — see ARD §4 / Argilla pattern).
  policyDefaults: jsonb('policy_defaults').notNull().default({}),
  // HKDF IKM for per-artifact commitment keys. Never destroyed, never exported.
  rootKey: varchar('root_key', { length: 64 })
    .notNull()
    .$defaultFn(() => randomBytes(32).toString('hex')),
  // Structural tenancy for training/grounding (ARD §33.2): a plan switch, not
  // a boolean flag. Enterprise and self-host cannot enter the training path.
  plan: workspacePlanEnum('plan').notNull().default('cloud_paid'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    role: workspaceRoleEnum('role').notNull().default('reviewer'),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workspace_members_user_ws_uq').on(t.userId, t.workspaceId)]
);

export const invitations = pgTable('invitations', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  email: varchar('email', { length: 255 }).notNull(),
  role: workspaceRoleEnum('role').notNull().default('reviewer'),
  invitedBy: text('invited_by')
    .notNull()
    .references(() => user.id),
  invitedAt: timestamp('invited_at').notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
});

export const activityLogs = pgTable('activity_logs', {
  id: serial('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  userId: text('user_id').references(() => user.id),
  action: text('action').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    // Soft hide. The row stays so the slug remains unique and create-review
    // can name `project_archived`. Nothing is hard-deleted.
    archivedAt: timestamp('archived_at'),
  },
  (t) => [uniqueIndex('projects_ws_slug_uq').on(t.workspaceId, t.slug)]
);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  name: varchar('name', { length: 100 }).notNull(),
  keyHash: text('key_hash').notNull().unique(), // sha256 of the bearer token
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(), // display only
  // Server-side pull cursor: last event id this key's consumer has seen.
  // Consumers keep zero local state (ARD §9).
  cursorEventId: integer('cursor_event_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
  revokedAt: timestamp('revoked_at'),
});

// ---------------------------------------------------------------------------
// Queues, policy versions, criteria
// ---------------------------------------------------------------------------

export const queues = pgTable(
  'queues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    environment: queueEnvironmentEnum('environment').notNull().default('production'),
    openForReview: boolean('open_for_review').notNull().default(true),
    // Explicit per-queue overrides of workspace policy defaults. Only the keys
    // an operator has actually set live here; everything else inherits. The
    // resolved snapshot is what gets frozen into a policy_versions row.
    policyOverrides: jsonb('policy_overrides').notNull().default({}),
    // Set after the first policy version is created (circular FK avoided by
    // keeping this nullable and pointing at policy_versions.id).
    activePolicyVersionId: uuid('active_policy_version_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    // Soft hide of both environment rows of a slug. create-review names
    // `queue_archived`. Slug uniqueness still covers archived rows.
    archivedAt: timestamp('archived_at'),
  },
  (t) => [uniqueIndex('queues_project_slug_env_uq').on(t.projectId, t.slug, t.environment)]
);

// Every policy change creates a new immutable version (ARD: reversible, never
// a silent mutation). `config` is zod-validated at the boundary; shape lives
// in lib/core/policy.ts.
export const policyVersions = pgTable(
  'policy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id),
    version: integer('version').notNull(),
    config: jsonb('config').notNull(),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policy_versions_queue_version_uq').on(t.queueId, t.version)]
);

export const criteria = pgTable(
  'criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id),
    key: varchar('key', { length: 64 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at'),
  },
  (t) => [uniqueIndex('criteria_queue_key_uq').on(t.queueId, t.key)]
);

// ---------------------------------------------------------------------------
// Review requests & artifact versions
// ---------------------------------------------------------------------------

export const reviewRequests = pgTable(
  'review_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => queues.id),
    // Customer-owned identity: the stacking contract (ARD §9). Upsert key.
    customerRequestId: varchar('customer_request_id', { length: 255 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    priority: integer('priority').notNull().default(3), // 1 = highest
    status: requestStatusEnum('status').notNull().default('open'),
    round: integer('round').notNull().default(1),
    stickyReviewerId: text('sticky_reviewer_id').references(() => user.id),
    pipelineRunId: varchar('pipeline_run_id', { length: 255 }),
    traceId: varchar('trace_id', { length: 255 }),
    // Context bundle (what the reviewer judges against)
    prompt: text('prompt'),
    source: text('source'),
    slaDueAt: timestamp('sla_due_at'),
    // Policy version stamped at creation; carried into every signed event.
    policyVersionId: uuid('policy_version_id')
      .notNull()
      .references(() => policyVersions.id),
    acceptedVersionId: uuid('accepted_version_id'),
    acceptedHash: varchar('accepted_hash', { length: 64 }),
    // Archive is a soft state, deliberately NOT a status value: `status` is the
    // review state and the four-state pull contract reads it. An archived
    // request keeps whatever status it had and drops out of the queue and the
    // pull. Nothing is ever hard-deleted — versions and events reference it.
    archivedAt: timestamp('archived_at'),
    archivedBy: text('archived_by').references(() => user.id),
    // Set when the Nth reject (policy.roundBudget) ships. Status becomes
    // escalated so the pipeline does not regenerate. Approve still closes it.
    // The flag feeds the operator failing-requests page.
    budgetExhaustedAt: timestamp('budget_exhausted_at'),
    budgetExhaustedBy: text('budget_exhausted_by').references(() => user.id),
    // Routing-confidence signal from the latest completed judge run. Never a
    // verdict. Null until a run completes (or when the version was not sampled).
    judgeOverallScore: real('judge_overall_score'),
    // Stamped at creation from policy.judgeBlindSamplingPct. Immutable for the
    // request: later policy edits do not flip blindness (ARD §26).
    judgeBlind: boolean('judge_blind').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('review_requests_project_customer_uq').on(
      t.projectId,
      t.customerRequestId
    ),
    index('review_requests_queue_status_idx').on(t.queueId, t.status),
    index('review_requests_updated_idx').on(t.updatedAt),
  ]
);

export const requestTags = pgTable(
  'request_tags',
  {
    id: serial('id').primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    tag: varchar('tag', { length: 100 }).notNull(),
  },
  (t) => [uniqueIndex('request_tags_uq').on(t.requestId, t.tag)]
);

export const contextFiles = pgTable('context_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => reviewRequests.id),
  name: varchar('name', { length: 255 }).notNull(),
  s3Key: text('s3_key').notNull(),
  contentType: varchar('content_type', { length: 100 }),
  size: integer('size'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    versionNumber: integer('version_number').notNull(), // 1-based
    authorKind: authorKindEnum('author_kind').notNull().default('model'),
    authorLabel: varchar('author_label', { length: 200 }), // e.g. "model run · support-gen-2"
    contentMd: text('content_md').notNull(), // markdown-only MVP
    // SHA-256(commitment_key || content). Not a bare content digest.
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    // Materialised HKDF(workspace_root, artifact_id || file_path). Null after erasure.
    commitmentKey: varchar('commitment_key', { length: 64 }),
    contentPurgedAt: timestamp('content_purged_at'),
    keyDestroyedAt: timestamp('key_destroyed_at'),
    humanAuthored: boolean('human_authored').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('artifact_versions_request_number_uq').on(
      t.requestId,
      t.versionNumber
    ),
    // Idempotency backstop: same parent+content never stacks twice.
    uniqueIndex('artifact_versions_request_hash_number_uq').on(
      t.requestId,
      t.contentHash,
      t.versionNumber
    ),
  ]
);

// Optional per-finding responses riding on a version submission
// ("needs clarification" instead of a guessed fix — ARD §9).
export const versionResponses = pgTable('version_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => artifactVersions.id),
  annotationId: uuid('annotation_id').notNull(),
  note: text('note').notNull(),
});

// ---------------------------------------------------------------------------
// Annotations (anchored comments) & re-anchoring state
// ---------------------------------------------------------------------------

export const annotations = pgTable(
  'annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    bornRound: integer('born_round').notNull(),
    bornVersionId: uuid('born_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => user.id),
    body: text('body').notNull(),
    expected: text('expected'), // the testable expected outcome (PRD s3.1.2)
    // W3C-style dual anchor: TextQuote (quote+prefix+suffix) + TextPosition
    quote: text('quote').notNull(),
    prefix: text('prefix').notNull().default(''),
    suffix: text('suffix').notNull().default(''),
    startPos: integer('start_pos').notNull(),
    endPos: integer('end_pos').notNull(),
    parentId: uuid('parent_id'), // thread reply → parent annotation
    resolvedAt: timestamp('resolved_at'), // resolve unblocks approve; does NOT ship
    resolvedBy: text('resolved_by').references(() => user.id),
    retiredAt: timestamp('retired_at'),
    retireReason: text('retire_reason'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('annotations_request_idx').on(t.requestId)]
);

/**
 * Suggestion rows on a version. Pending = old text still shown. Applied =
 * folded into working text. Save writes one human version from applied rows.
 */
export const manualEdits = pgTable(
  'manual_edits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    baseVersionId: uuid('base_version_id')
      .notNull()
      .references(() => artifactVersions.id),
    startPos: integer('start_pos').notNull(),
    endPos: integer('end_pos').notNull(),
    originalQuote: text('original_quote').notNull(),
    replacement: text('replacement').notNull(),
    status: manualEditStatusEnum('status').notNull().default('pending'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    decidedAt: timestamp('decided_at'),
  },
  (t) => [index('manual_edits_request_status_idx').on(t.requestId, t.status)]
);

// Classification of every prior annotation against every later version.
export const anchorStates = pgTable(
  'anchor_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    annotationId: uuid('annotation_id')
      .notNull()
      .references(() => annotations.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    state: anchorStateEnum('state').notNull(),
    confidence: anchorConfidenceEnum('confidence').notNull(),
    // Landing spot on this version (null when orphaned)
    newQuote: text('new_quote'),
    newPrefix: text('new_prefix'),
    newSuffix: text('new_suffix'),
    newStartPos: integer('new_start_pos'),
    newEndPos: integer('new_end_pos'),
    confirmation: anchorConfirmationEnum('confirmation'), // human override wins
    reasserted: boolean('reasserted').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('anchor_states_annotation_version_uq').on(t.annotationId, t.versionId)]
);

// Original selectors are never lost: every manual re-pin appends here.
export const repinHistory = pgTable('repin_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  annotationId: uuid('annotation_id')
    .notNull()
    .references(() => annotations.id),
  versionId: uuid('version_id')
    .notNull()
    .references(() => artifactVersions.id),
  oldQuote: text('old_quote'),
  oldStartPos: integer('old_start_pos'),
  oldEndPos: integer('old_end_pos'),
  newQuote: text('new_quote').notNull(),
  newStartPos: integer('new_start_pos').notNull(),
  newEndPos: integer('new_end_pos').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Criteria verdicts & decisions
// ---------------------------------------------------------------------------

export const criteriaVerdicts = pgTable(
  'criteria_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    criterionId: uuid('criterion_id')
      .notNull()
      .references(() => criteria.id),
    verdict: criterionVerdictEnum('verdict').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('criteria_verdicts_version_criterion_user_uq').on(
      t.versionId,
      t.criterionId,
      t.userId
    ),
  ]
);

export const decisions = pgTable('decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id')
    .notNull()
    .references(() => reviewRequests.id),
  versionId: uuid('version_id')
    .notNull()
    .references(() => artifactVersions.id),
  round: integer('round').notNull(),
  kind: decisionKindEnum('kind').notNull(),
  reason: text('reason'), // required (≥4 chars) for escalate; enforced in service
  decidedBy: text('decided_by')
    .notNull()
    .references(() => user.id),
  sealedHash: varchar('sealed_hash', { length: 64 }), // set on approve/approve_edited
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Events (append-only, per-request hash chain) & webhook delivery
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    seq: integer('seq').notNull(), // 1-based within request
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    prevHash: varchar('prev_hash', { length: 64 }).notNull(), // 64 zeros at genesis
    hash: varchar('hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('events_request_seq_uq').on(t.requestId, t.seq),
    index('events_id_request_idx').on(t.id, t.requestId),
  ]
);

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  url: text('url').notNull(),
  secret: text('secret').notNull(), // Standard Webhooks signing secret (whsec_…)
  eventTypes: jsonb('event_types').notNull().default([]), // [] = all
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: integer('event_id').notNull(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at'),
    ackedAt: timestamp('acked_at'),
    responseCode: integer('response_code'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('webhook_deliveries_event_endpoint_uq').on(t.eventId, t.endpointId)]
);

// ---------------------------------------------------------------------------
// Machine findings, producers, judge runs (VOBO-30)
// ---------------------------------------------------------------------------

export const findingProducers = pgTable(
  'finding_producers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    builtin: boolean('builtin').notNull().default(false),
    mutedAt: timestamp('muted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('finding_producers_project_slug_uq').on(t.projectId, t.slug)]
);

export const producerKeys = pgTable(
  'producer_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    producerId: uuid('producer_id')
      .notNull()
      .references(() => findingProducers.id),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(600),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('producer_keys_producer_idx').on(t.producerId)]
);

export const findingBatches = pgTable(
  'finding_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    producerId: uuid('producer_id')
      .notNull()
      .references(() => findingProducers.id),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    findingIds: jsonb('finding_ids').notNull().default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('finding_batches_version_producer_key_uq').on(
      t.versionId,
      t.producerId,
      t.idempotencyKey
    ),
  ]
);

export const machineFindings = pgTable(
  'machine_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    producerId: uuid('producer_id')
      .notNull()
      .references(() => findingProducers.id),
    judgeRunId: uuid('judge_run_id'),
    criterionKey: varchar('criterion_key', { length: 64 }).notNull(),
    severity: findingSeverityEnum('severity').notNull().default('minor'),
    quote: text('quote').notNull(),
    prefix: text('prefix').notNull().default(''),
    suffix: text('suffix').notNull().default(''),
    startPos: integer('start_pos').notNull(),
    endPos: integer('end_pos').notNull(),
    structuralContainer: varchar('structural_container', { length: 255 }),
    structuralBlockId: varchar('structural_block_id', { length: 255 }),
    structuralOrdinal: integer('structural_ordinal'),
    evidence: text('evidence').notNull(),
    note: text('note').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    /** Per-criterion boolean from the judge. Humans override on the criterion card. */
    passed: boolean('passed').notNull().default(false),
    /** 0–1 confidence that this criterion passed. Null when the producer omitted it. */
    score: real('score'),
    triage: findingTriageEnum('triage').notNull().default('untriaged'),
    dismissalReason: text('dismissal_reason'),
    dismissedBy: text('dismissed_by').references(() => user.id),
    dismissedAt: timestamp('dismissed_at'),
    confirmedAnnotationId: uuid('confirmed_annotation_id').references(() => annotations.id),
    confirmedBy: text('confirmed_by').references(() => user.id),
    confirmedAt: timestamp('confirmed_at'),
    purgedAt: timestamp('purged_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('machine_findings_request_idx').on(t.requestId),
    index('machine_findings_version_idx').on(t.versionId),
    index('machine_findings_fingerprint_idx').on(t.requestId, t.fingerprint),
  ]
);

export const dismissalMemory = pgTable(
  'dismissal_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
    reason: text('reason').notNull(),
    dismissedBy: text('dismissed_by').references(() => user.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dismissal_memory_request_fp_uq').on(t.requestId, t.fingerprint)]
);

export const judgeRuns = pgTable(
  'judge_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    policyVersionId: uuid('policy_version_id')
      .notNull()
      .references(() => policyVersions.id),
    state: judgeRunStateEnum('state').notNull().default('pending'),
    overallScore: real('overall_score'),
    errorClass: varchar('error_class', { length: 64 }),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    /** Increments on each reviewer rerun so ingest keys stay unique per attempt. */
    rerunSeq: integer('rerun_seq').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('judge_runs_version_uq').on(t.versionId)]
);

export const judgeRecords = pgTable(
  'judge_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id),
    runId: uuid('run_id').references(() => judgeRuns.id),
    // Append-only per-workspace log (VOBO-198). Reviewer identity is hashed
    // at the boundary; raw user ids never land here (VOBO-201).
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('judge_records_workspace_idx').on(t.workspaceId, t.id)]
);

// ---------------------------------------------------------------------------
// Leases (atomic claims)
// ---------------------------------------------------------------------------

export const leases = pgTable(
  'leases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => reviewRequests.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('leases_request_uq').on(t.requestId)]
);

// ---------------------------------------------------------------------------
// Relations (query-layer sugar)
// ---------------------------------------------------------------------------

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  projects: many(projects),
  invitations: many(invitations),
}));

export const userRelations = relations(user, ({ many }) => ({
  memberships: many(workspaceMembers),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  user: one(user, { fields: [workspaceMembers.userId], references: [user.id] }),
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [invitations.workspaceId],
    references: [workspaces.id],
  }),
  invitedByUser: one(user, {
    fields: [invitations.invitedBy],
    references: [user.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
  queues: many(queues),
  apiKeys: many(apiKeys),
}));

export const queuesRelations = relations(queues, ({ one, many }) => ({
  project: one(projects, { fields: [queues.projectId], references: [projects.id] }),
  policyVersions: many(policyVersions),
  criteria: many(criteria),
  requests: many(reviewRequests),
}));

export const reviewRequestsRelations = relations(reviewRequests, ({ one, many }) => ({
  queue: one(queues, { fields: [reviewRequests.queueId], references: [queues.id] }),
  project: one(projects, {
    fields: [reviewRequests.projectId],
    references: [projects.id],
  }),
  versions: many(artifactVersions),
  annotations: many(annotations),
  events: many(events),
  tags: many(requestTags),
  files: many(contextFiles),
  decisions: many(decisions),
}));

export const artifactVersionsRelations = relations(artifactVersions, ({ one, many }) => ({
  request: one(reviewRequests, {
    fields: [artifactVersions.requestId],
    references: [reviewRequests.id],
  }),
  anchorStates: many(anchorStates),
}));

export const annotationsRelations = relations(annotations, ({ one, many }) => ({
  request: one(reviewRequests, {
    fields: [annotations.requestId],
    references: [reviewRequests.id],
  }),
  author: one(user, { fields: [annotations.authorUserId], references: [user.id] }),
  states: many(anchorStates),
}));

export const anchorStatesRelations = relations(anchorStates, ({ one }) => ({
  annotation: one(annotations, {
    fields: [anchorStates.annotationId],
    references: [annotations.id],
  }),
  version: one(artifactVersions, {
    fields: [anchorStates.versionId],
    references: [artifactVersions.id],
  }),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  request: one(reviewRequests, {
    fields: [events.requestId],
    references: [reviewRequests.id],
  }),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  endpoint: one(webhookEndpoints, {
    fields: [webhookDeliveries.endpointId],
    references: [webhookEndpoints.id],
  }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [activityLogs.workspaceId],
    references: [workspaces.id],
  }),
  user: one(user, { fields: [activityLogs.userId], references: [user.id] }),
}));

export const policyVersionsRelations = relations(policyVersions, ({ one }) => ({
  queue: one(queues, { fields: [policyVersions.queueId], references: [queues.id] }),
}));

export const findingProducersRelations = relations(findingProducers, ({ one, many }) => ({
  project: one(projects, { fields: [findingProducers.projectId], references: [projects.id] }),
  keys: many(producerKeys),
}));

export const producerKeysRelations = relations(producerKeys, ({ one }) => ({
  producer: one(findingProducers, {
    fields: [producerKeys.producerId],
    references: [findingProducers.id],
  }),
}));

export const findingBatchesRelations = relations(findingBatches, ({ one }) => ({
  version: one(artifactVersions, {
    fields: [findingBatches.versionId],
    references: [artifactVersions.id],
  }),
  producer: one(findingProducers, {
    fields: [findingBatches.producerId],
    references: [findingProducers.id],
  }),
}));

export const machineFindingsRelations = relations(machineFindings, ({ one }) => ({
  request: one(reviewRequests, {
    fields: [machineFindings.requestId],
    references: [reviewRequests.id],
  }),
  version: one(artifactVersions, {
    fields: [machineFindings.versionId],
    references: [artifactVersions.id],
  }),
  producer: one(findingProducers, {
    fields: [machineFindings.producerId],
    references: [findingProducers.id],
  }),
}));

export const dismissalMemoryRelations = relations(dismissalMemory, ({ one }) => ({
  request: one(reviewRequests, {
    fields: [dismissalMemory.requestId],
    references: [reviewRequests.id],
  }),
}));

export const judgeRunsRelations = relations(judgeRuns, ({ one }) => ({
  request: one(reviewRequests, {
    fields: [judgeRuns.requestId],
    references: [reviewRequests.id],
  }),
  version: one(artifactVersions, {
    fields: [judgeRuns.versionId],
    references: [artifactVersions.id],
  }),
}));

export const judgeRecordsRelations = relations(judgeRecords, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [judgeRecords.workspaceId],
    references: [workspaces.id],
  }),
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Queue = typeof queues.$inferSelect;
export type PolicyVersion = typeof policyVersions.$inferSelect;
export type Criterion = typeof criteria.$inferSelect;
export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type NewReviewRequest = typeof reviewRequests.$inferInsert;
export type ArtifactVersion = typeof artifactVersions.$inferSelect;
export type Annotation = typeof annotations.$inferSelect;
export type AnchorState = typeof anchorStates.$inferSelect;
export type CriteriaVerdict = typeof criteriaVerdicts.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type Lease = typeof leases.$inferSelect;
export type FindingProducer = typeof findingProducers.$inferSelect;
export type ProducerKey = typeof producerKeys.$inferSelect;
export type MachineFinding = typeof machineFindings.$inferSelect;
export type JudgeRun = typeof judgeRuns.$inferSelect;
export type JudgeRecord = typeof judgeRecords.$inferSelect;
export type ManualEdit = typeof manualEdits.$inferSelect;
export type DismissalMemory = typeof dismissalMemory.$inferSelect;

/** Workspace as returned to the app/client — the HKDF root is omitted. */
export type PublicWorkspace = Omit<Workspace, 'rootKey'>;

export type WorkspaceDataWithMembers = PublicWorkspace & {
  members: (WorkspaceMember & {
    user: Pick<User, 'id' | 'name' | 'email'>;
  })[];
};

export enum ActivityType {
  SIGN_UP = 'SIGN_UP',
  SIGN_IN = 'SIGN_IN',
  SIGN_OUT = 'SIGN_OUT',
  UPDATE_PASSWORD = 'UPDATE_PASSWORD',
  DELETE_ACCOUNT = 'DELETE_ACCOUNT',
  UPDATE_ACCOUNT = 'UPDATE_ACCOUNT',
  CREATE_WORKSPACE = 'CREATE_WORKSPACE',
  REMOVE_WORKSPACE_MEMBER = 'REMOVE_WORKSPACE_MEMBER',
  INVITE_WORKSPACE_MEMBER = 'INVITE_WORKSPACE_MEMBER',
  ACCEPT_INVITATION = 'ACCEPT_INVITATION',
}
