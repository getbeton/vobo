import { commitContent } from './commitment';
import {
  ChainRow,
  ChainVerification,
  ERASURE_EVENT,
  verifyChain,
} from './events';

export const AUDIT_BUNDLE_FORMAT = 'vobo-audit-bundle/v1';

export type EvidenceStatus = 'verified' | 'intentionally_voided' | 'FAILED';

export interface AuditBundleArtifact {
  id: string;
  version_number: number;
  file_path: string;
  /** Original body, or null when purged (expiry or erasure). */
  content: string | null;
  commitment: string;
  /** Present only when the scope has not been erased. */
  commitment_key?: string;
}

export interface AuditBundleEvent {
  seq: number;
  type: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export interface AuditBundleRequest {
  id: string;
  customer_request_id: string;
  artifacts: AuditBundleArtifact[];
  events: AuditBundleEvent[];
}

export interface AuditBundle {
  format: typeof AUDIT_BUNDLE_FORMAT;
  exported_at: string;
  workspace_id: number;
  requests: AuditBundleRequest[];
}

export interface ArtifactVerdict {
  artifactId: string;
  status: EvidenceStatus;
  erasureSeq?: number;
  reason?: string;
}

export interface BundleVerification {
  status: EvidenceStatus;
  chain: ChainVerification;
  artifacts: ArtifactVerdict[];
  voids: Array<{ seq: number; artifactIds: string[]; authorizingRequestId?: string }>;
}

interface ErasureScope {
  seq: number;
  artifactIds: Set<string>;
  authorizingRequestId?: string;
}

function erasureScopes(evts: AuditBundleEvent[]): ErasureScope[] {
  const out: ErasureScope[] = [];
  for (const e of evts) {
    if (e.type !== ERASURE_EVENT) continue;
    const payload = (e.payload ?? {}) as {
      authorizing_request_id?: string;
      scope?: { artifact_version_ids?: unknown };
    };
    const ids = Array.isArray(payload.scope?.artifact_version_ids)
      ? payload.scope.artifact_version_ids.filter((id): id is string => typeof id === 'string')
      : [];
    out.push({
      seq: e.seq,
      artifactIds: new Set(ids),
      authorizingRequestId: payload.authorizing_request_id,
    });
  }
  return out;
}

function coveringErasure(scopes: ErasureScope[], artifactId: string): ErasureScope | undefined {
  return scopes.find((s) => s.artifactIds.has(artifactId));
}

function verifyOneArtifact(
  artifact: AuditBundleArtifact,
  scopes: ErasureScope[]
): ArtifactVerdict {
  const erasure = coveringErasure(scopes, artifact.id);
  const key = artifact.commitment_key;

  if (!key) {
    if (erasure) {
      return {
        artifactId: artifact.id,
        status: 'intentionally_voided',
        erasureSeq: erasure.seq,
      };
    }
    return {
      artifactId: artifact.id,
      status: 'FAILED',
      reason: 'missing_key',
    };
  }

  if (erasure) {
    // Key survived an erasure event — the void is incomplete.
    return {
      artifactId: artifact.id,
      status: 'FAILED',
      reason: 'key_present_after_erasure',
      erasureSeq: erasure.seq,
    };
  }

  if (artifact.content === null) {
    // Routine expiry: body gone, key retained. Not a void.
    return { artifactId: artifact.id, status: 'verified' };
  }

  const actual = commitContent(key, artifact.content);
  if (actual !== artifact.commitment) {
    return {
      artifactId: artifact.id,
      status: 'FAILED',
      reason: 'commitment_mismatch',
    };
  }
  return { artifactId: artifact.id, status: 'verified' };
}

function foldStatus(parts: EvidenceStatus[]): EvidenceStatus {
  if (parts.includes('FAILED')) return 'FAILED';
  if (parts.includes('intentionally_voided')) return 'intentionally_voided';
  return 'verified';
}

function chainRowsFor(req: AuditBundleRequest): ChainRow[] {
  return req.events.map((e) => ({
    requestId: req.id,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    prevHash: e.prev_hash,
    hash: e.hash,
  }));
}

/** Three-state verifier over an audit bundle. Does not re-derive keys. */
export function verifyAuditBundle(bundle: AuditBundle): BundleVerification {
  const artifactVerdicts: ArtifactVerdict[] = [];
  const voids: BundleVerification['voids'] = [];
  let chainResult: ChainVerification = { ok: true };

  for (const req of bundle.requests) {
    const chain = verifyChain(chainRowsFor(req));
    if (!chain.ok) {
      if (chainResult.ok) chainResult = chain;
      for (const a of req.artifacts) {
        artifactVerdicts.push({
          artifactId: a.id,
          status: 'FAILED',
          reason: 'chain_broken',
        });
      }
      continue;
    }

    const scopes = erasureScopes(req.events);
    for (const a of req.artifacts) {
      const v = verifyOneArtifact(a, scopes);
      artifactVerdicts.push(v);
      if (v.status === 'intentionally_voided' && v.erasureSeq !== undefined) {
        const scope = scopes.find((s) => s.seq === v.erasureSeq);
        if (scope && !voids.some((x) => x.seq === scope.seq)) {
          voids.push({
            seq: scope.seq,
            artifactIds: [...scope.artifactIds],
            authorizingRequestId: scope.authorizingRequestId,
          });
        }
      }
    }
  }

  const status = foldStatus([
    chainResult.ok ? 'verified' : 'FAILED',
    ...artifactVerdicts.map((a) => a.status),
  ]);

  return { status, chain: chainResult, artifacts: artifactVerdicts, voids };
}
