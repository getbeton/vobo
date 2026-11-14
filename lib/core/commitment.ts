import { createHash, hkdfSync, randomBytes } from 'crypto';

/**
 * Per-artifact content commitments (ARD §22.3 / §57.2).
 *
 * commitment = SHA-256(commitment_key || content)
 * commitment_key = HKDF-SHA256(workspace_root, info = artifact_id || file_path)
 *
 * The workspace root is never destroyed. Derived keys are materialised next
 * to the artifact; erasure deletes that copy and does not re-derive it.
 */

export const WORKSPACE_ROOT_BYTES = 32;
export const COMMITMENT_KEY_BYTES = 32;
export const HKDF_SALT = Buffer.from('vobo-commitment-v1');
/** Markdown body — the only file path in the MVP. */
export const MARKDOWN_BODY_PATH = '';

export function generateWorkspaceRoot(): string {
  return randomBytes(WORKSPACE_ROOT_BYTES).toString('hex');
}

export function deriveCommitmentKey(
  workspaceRootHex: string,
  artifactId: string,
  filePath: string = MARKDOWN_BODY_PATH
): string {
  const ikm = Buffer.from(workspaceRootHex, 'hex');
  if (ikm.length !== WORKSPACE_ROOT_BYTES) {
    throw new Error('workspace root must be 32 bytes hex');
  }
  const info = Buffer.concat([
    Buffer.from(artifactId, 'utf8'),
    Buffer.from(filePath, 'utf8'),
  ]);
  return Buffer.from(
    hkdfSync('sha256', ikm, HKDF_SALT, info, COMMITMENT_KEY_BYTES)
  ).toString('hex');
}

/** SHA-256(commitment_key || content). Key is hex; content is UTF-8. */
export function commitContent(commitmentKeyHex: string, content: string): string {
  const key = Buffer.from(commitmentKeyHex, 'hex');
  if (key.length !== COMMITMENT_KEY_BYTES) {
    throw new Error('commitment key must be 32 bytes hex');
  }
  return createHash('sha256').update(key).update(content, 'utf8').digest('hex');
}

export function verifyCommitment(
  commitmentKeyHex: string,
  content: string,
  expectedHex: string
): boolean {
  const actual = commitContent(commitmentKeyHex, content);
  if (actual.length !== expectedHex.length) return false;
  // Lengths are fixed (64 hex chars); compare via the hashes themselves.
  return actual === expectedHex;
}
