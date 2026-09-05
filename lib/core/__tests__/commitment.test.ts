import { describe, it, expect } from 'vitest';
import { createHash, hkdfSync } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  commitContent,
  deriveCommitmentKey,
  generateWorkspaceRoot,
  verifyCommitment,
  MARKDOWN_BODY_PATH,
} from '../commitment';

describe('per-artifact commitment keys', () => {
  const root = 'ab'.repeat(32);
  const artifactA = '11111111-1111-1111-1111-111111111111';
  const artifactB = '22222222-2222-2222-2222-222222222222';

  it('HKDF matches Node hkdfSync(root, artifact_id || file_path)', () => {
    const key = deriveCommitmentKey(root, artifactA, MARKDOWN_BODY_PATH);
    const independent = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(root, 'hex'),
        Buffer.from('vobo-commitment-v1'),
        Buffer.from(artifactA, 'utf8'),
        32
      )
    ).toString('hex');
    expect(key).toBe(independent);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('commitment is SHA-256(key || content), not a bare content digest', () => {
    const key = deriveCommitmentKey(root, artifactA);
    const content = 'hello';
    const commitment = commitContent(key, content);
    const keyed = createHash('sha256')
      .update(Buffer.from(key, 'hex'))
      .update(content, 'utf8')
      .digest('hex');
    const bare = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(commitment).toBe(keyed);
    expect(commitment).not.toBe(bare);
    expect(verifyCommitment(key, content, commitment)).toBe(true);
    expect(verifyCommitment(key, content + ' ', commitment)).toBe(false);
  });

  it('different artifacts derive different keys even for identical content', () => {
    const a = deriveCommitmentKey(root, artifactA);
    const b = deriveCommitmentKey(root, artifactB);
    expect(a).not.toBe(b);
    expect(commitContent(a, 'same')).not.toBe(commitContent(b, 'same'));
  });

  it('file_path is bound into the key', () => {
    const body = deriveCommitmentKey(root, artifactA, '');
    const file = deriveCommitmentKey(root, artifactA, 'docs/readme.md');
    expect(body).not.toBe(file);
  });

  it('workspace roots are 32-byte hex and not reused across generate calls', () => {
    const x = generateWorkspaceRoot();
    const y = generateWorkspaceRoot();
    expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(x).not.toBe(y);
  });
});

describe('expiry and erasure stay separate modules', () => {
  it('expiry never mentions commitment keys or the erasure module', () => {
    const src = readFileSync(resolve(__dirname, '../expiry.ts'), 'utf8');
    expect(src).not.toMatch(/\bcommitmentKey\b|\bkeyDestroyedAt\b/);
    expect(src).not.toMatch(/from ['\"]\.\/erasure['\"]|from ['\"]@\/lib\/core\/erasure['\"]/);
  });

  it('erasure never touches the workspace root', () => {
    const src = readFileSync(resolve(__dirname, '../erasure.ts'), 'utf8');
    expect(src).not.toMatch(/\brootKey\b|\bworkspaces\b/);
  });
});
