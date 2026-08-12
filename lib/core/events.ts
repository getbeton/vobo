import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Per-request append-only hash chain (architecture decision 3A) and
 * Standard Webhooks signing (https://www.standardwebhooks.com/).
 * Pure functions — persistence and delivery live in the service layer.
 */

export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export interface EventForHash {
  requestId: string;
  seq: number;
  type: string;
  payload: unknown;
  prevHash: string;
}

export function computeEventHash(e: EventForHash): string {
  const canonical = stableStringify({
    requestId: e.requestId,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    prevHash: e.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface ChainRow {
  requestId: string;
  seq: number;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  ok: boolean;
  /** First seq whose stored hash or linkage fails; undefined when ok. */
  brokenAtSeq?: number;
}

/** Verify one request's chain, rows ordered by seq ascending. */
export function verifyChain(rows: ChainRow[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== prev) return { ok: false, brokenAtSeq: row.seq };
    const expected = computeEventHash(row);
    if (row.hash !== expected) return { ok: false, brokenAtSeq: row.seq };
    prev = row.hash;
  }
  return { ok: true };
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Standard Webhooks signing
// ---------------------------------------------------------------------------

const WHSEC_PREFIX = 'whsec_';

export function generateWebhookSecret(random: Buffer): string {
  return WHSEC_PREFIX + random.toString('base64');
}

function secretBytes(secret: string): Buffer {
  const raw = secret.startsWith(WHSEC_PREFIX)
    ? secret.slice(WHSEC_PREFIX.length)
    : secret;
  return Buffer.from(raw, 'base64');
}

/**
 * Signature per the Standard Webhooks spec: base64(HMAC-SHA256(secret,
 * `${msgId}.${timestampSeconds}.${payload}`)), prefixed with the scheme `v1,`.
 */
export function signWebhook(
  secret: string,
  msgId: string,
  timestampSeconds: number,
  payload: string
): string {
  const signedContent = `${msgId}.${timestampSeconds}.${payload}`;
  const sig = createHmac('sha256', secretBytes(secret))
    .update(signedContent, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

export function webhookHeaders(
  secret: string,
  msgId: string,
  timestamp: Date,
  payload: string
): Record<string, string> {
  const ts = Math.floor(timestamp.getTime() / 1000);
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(ts),
    'webhook-signature': signWebhook(secret, msgId, ts, payload),
    'content-type': 'application/json',
  };
}

/** Constant-time verification (consumer side; also used in tests/SDK). */
export function verifyWebhookSignature(
  secret: string,
  msgId: string,
  timestampSeconds: number,
  payload: string,
  signatureHeader: string
): boolean {
  const expected = signWebhook(secret, msgId, timestampSeconds, payload);
  // Header may carry multiple space-delimited signatures.
  return signatureHeader.split(' ').some((candidate) => {
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  });
}
