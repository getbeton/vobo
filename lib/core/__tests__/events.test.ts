import { describe, it, expect } from 'vitest';
import { randomBytes, createHmac } from 'crypto';
import {
  GENESIS_HASH,
  computeEventHash,
  verifyChain,
  stableStringify,
  contentHash,
  generateWebhookSecret,
  signWebhook,
  webhookHeaders,
  verifyWebhookSignature,
  ChainRow,
} from '../events';

function buildChain(requestId: string, items: Array<{ type: string; payload: unknown }>): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS_HASH;
  items.forEach((item, i) => {
    const row = {
      requestId,
      seq: i + 1,
      type: item.type,
      payload: item.payload,
      prevHash: prev,
    };
    const hash = computeEventHash(row);
    rows.push({ ...row, hash });
    prev = hash;
  });
  return rows;
}

describe('event hash chain', () => {
  it('a well-formed chain verifies end-to-end', () => {
    const rows = buildChain('req-1', [
      { type: 'request.created', payload: { v: 1 } },
      { type: 'version.submitted', payload: { version: 2 } },
      { type: 'decision.rejected', payload: { corrections: 3 } },
    ]);
    expect(verifyChain(rows)).toEqual({ ok: true });
  });

  it('tampering any payload breaks verification at that seq', () => {
    const rows = buildChain('req-1', [
      { type: 'a', payload: { x: 1 } },
      { type: 'b', payload: { x: 2 } },
      { type: 'c', payload: { x: 3 } },
    ]);
    (rows[1].payload as any).x = 999;
    const v = verifyChain(rows);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
  });

  it('re-linking after tampering still fails downstream (chain property)', () => {
    const rows = buildChain('req-1', [
      { type: 'a', payload: { x: 1 } },
      { type: 'b', payload: { x: 2 } },
      { type: 'c', payload: { x: 3 } },
    ]);
    // Attacker rewrites event 2 AND its hash, but cannot fix event 3's prevHash
    // without rewriting the rest of the chain.
    (rows[1].payload as any).x = 999;
    rows[1].hash = computeEventHash(rows[1]);
    const v = verifyChain(rows);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
  });

  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 })
    );
  });

  it('contentHash is stable sha256 hex', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hello '));
  });
});

describe('standard webhooks signing', () => {
  const secret = generateWebhookSecret(randomBytes(24));

  it('produces the spec signature: v1,base64(hmac(msgId.ts.payload))', () => {
    const payload = JSON.stringify({ hello: 'world' });
    const sig = signWebhook(secret, 'msg_1', 1700000000, payload);
    const raw = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const expected =
      'v1,' +
      createHmac('sha256', raw).update(`msg_1.1700000000.${payload}`).digest('base64');
    expect(sig).toBe(expected);
  });

  it('headers carry id, timestamp (seconds) and signature that verifies', () => {
    const payload = JSON.stringify({ decision: 'approve' });
    const ts = new Date('2026-08-12T10:00:00Z');
    const h = webhookHeaders(secret, 'msg_2', ts, payload);
    expect(h['webhook-id']).toBe('msg_2');
    expect(h['webhook-timestamp']).toBe(String(Math.floor(ts.getTime() / 1000)));
    expect(
      verifyWebhookSignature(
        secret,
        'msg_2',
        Number(h['webhook-timestamp']),
        payload,
        h['webhook-signature']
      )
    ).toBe(true);
  });

  it('verification rejects a wrong secret or tampered payload', () => {
    const payload = '{"a":1}';
    const h = webhookHeaders(secret, 'msg_3', new Date(), payload);
    const otherSecret = generateWebhookSecret(randomBytes(24));
    expect(
      verifyWebhookSignature(otherSecret, 'msg_3', Number(h['webhook-timestamp']), payload, h['webhook-signature'])
    ).toBe(false);
    expect(
      verifyWebhookSignature(secret, 'msg_3', Number(h['webhook-timestamp']), '{"a":2}', h['webhook-signature'])
    ).toBe(false);
  });
});
