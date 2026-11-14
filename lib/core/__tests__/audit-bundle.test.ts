import { describe, it, expect } from 'vitest';
import { computeEventHash, GENESIS_HASH } from '../events';
import {
  AUDIT_BUNDLE_FORMAT,
  AuditBundle,
  verifyAuditBundle,
} from '../audit-bundle';
import { commitContent, deriveCommitmentKey } from '../commitment';
import { ERASURE_EVENT, EXPIRY_EVENT } from '../events';

const ROOT = 'cd'.repeat(32);
const REQ = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ART_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ART_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function keyFor(id: string) {
  return deriveCommitmentKey(ROOT, id, '');
}

function chain(items: Array<{ type: string; payload: unknown }>) {
  const rows: AuditBundle['requests'][0]['events'] = [];
  let prev = GENESIS_HASH;
  items.forEach((item, i) => {
    const seq = i + 1;
    const hash = computeEventHash({
      requestId: REQ,
      seq,
      type: item.type,
      payload: item.payload,
      prevHash: prev,
    });
    rows.push({
      seq,
      type: item.type,
      payload: item.payload,
      prev_hash: prev,
      hash,
      created_at: '2026-08-22T00:00:00.000Z',
    });
    prev = hash;
  });
  return rows;
}

function bundle(partial: {
  artifacts: AuditBundle['requests'][0]['artifacts'];
  events: AuditBundle['requests'][0]['events'];
}): AuditBundle {
  return {
    format: AUDIT_BUNDLE_FORMAT,
    exported_at: '2026-08-22T00:00:00.000Z',
    workspace_id: 1,
    requests: [
      {
        id: REQ,
        customer_request_id: 'pico/x',
        artifacts: partial.artifacts,
        events: partial.events,
      },
    ],
  };
}

describe('audit bundle verifier', () => {
  it('reports verified when keys are present and contents match', () => {
    const ka = keyFor(ART_A);
    const content = 'accepted body';
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content,
          commitment: commitContent(ka, content),
          commitment_key: ka,
        },
      ],
      events: chain([{ type: 'request.created', payload: { v: 1 } }]),
    });
    expect(JSON.stringify(b)).not.toContain(ROOT);
    expect(verifyAuditBundle(b).status).toBe('verified');
  });

  it('reports intentionally voided, with the erasure event, when the key is omitted', () => {
    const ka = keyFor(ART_A);
    const content = 'secret';
    const events = chain([
      { type: 'version.submitted', payload: { version: 1 } },
      {
        type: ERASURE_EVENT,
        payload: {
          authorizing_request_id: 'gdpr-17',
          scope: { request_id: REQ, artifact_version_ids: [ART_A] },
        },
      },
    ]);
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content: null,
          commitment: commitContent(ka, content),
          // key omitted
        },
      ],
      events,
    });
    expect(b.requests[0].artifacts[0]).not.toHaveProperty('commitment_key');
    const v = verifyAuditBundle(b);
    expect(v.status).toBe('intentionally_voided');
    expect(v.artifacts[0]).toMatchObject({
      artifactId: ART_A,
      status: 'intentionally_voided',
      erasureSeq: 2,
    });
    expect(v.voids[0]).toMatchObject({
      seq: 2,
      authorizingRequestId: 'gdpr-17',
    });
  });

  it('reports FAILED when content is tampered under a live key', () => {
    const ka = keyFor(ART_A);
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content: 'tampered',
          commitment: commitContent(ka, 'original'),
          commitment_key: ka,
        },
      ],
      events: chain([{ type: 'request.created', payload: {} }]),
    });
    const v = verifyAuditBundle(b);
    expect(v.status).toBe('FAILED');
    expect(v.artifacts[0].reason).toBe('commitment_mismatch');
  });

  it('reports FAILED when a key is missing with no erasure event', () => {
    const ka = keyFor(ART_A);
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content: 'x',
          commitment: commitContent(ka, 'x'),
        },
      ],
      events: chain([{ type: 'request.created', payload: {} }]),
    });
    expect(verifyAuditBundle(b).status).toBe('FAILED');
    expect(verifyAuditBundle(b).artifacts[0].reason).toBe('missing_key');
  });

  it('expiry (body gone, key kept) stays verified, not voided', () => {
    const ka = keyFor(ART_A);
    const events = chain([
      { type: 'version.submitted', payload: { version: 1 } },
      {
        type: EXPIRY_EVENT,
        payload: { request_id: REQ, artifact_version_ids: [ART_A] },
      },
    ]);
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content: null,
          commitment: commitContent(ka, 'original'),
          commitment_key: ka,
        },
      ],
      events,
    });
    const v = verifyAuditBundle(b);
    expect(v.status).toBe('verified');
    expect(v.artifacts[0].status).toBe('verified');
  });

  it('includes the live key and omits the erased sibling in one bundle', () => {
    const ka = keyFor(ART_A);
    const kb = keyFor(ART_B);
    const events = chain([
      { type: 'version.submitted', payload: { version: 1 } },
      {
        type: ERASURE_EVENT,
        payload: {
          authorizing_request_id: 'gdpr-file',
          scope: { artifact_version_ids: [ART_B] },
        },
      },
    ]);
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content: 'keep',
          commitment: commitContent(ka, 'keep'),
          commitment_key: ka,
        },
        {
          id: ART_B,
          version_number: 2,
          file_path: '',
          content: null,
          commitment: commitContent(kb, 'drop'),
        },
      ],
      events,
    });
    expect(b.requests[0].artifacts[0].commitment_key).toBe(ka);
    expect(b.requests[0].artifacts[1]).not.toHaveProperty('commitment_key');
    const v = verifyAuditBundle(b);
    expect(v.status).toBe('intentionally_voided');
    expect(v.artifacts.map((a) => a.status)).toEqual(['verified', 'intentionally_voided']);
  });

  it('a broken event chain is FAILED, not a void', () => {
    const ka = keyFor(ART_A);
    const events = chain([{ type: 'request.created', payload: { v: 1 } }]);
    events[0].payload = { v: 999 };
    const b = bundle({
      artifacts: [
        {
          id: ART_A,
          version_number: 1,
          file_path: '',
          content: 'ok',
          commitment: commitContent(ka, 'ok'),
          commitment_key: ka,
        },
      ],
      events,
    });
    expect(verifyAuditBundle(b).status).toBe('FAILED');
  });
});
