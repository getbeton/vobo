import { createHash } from 'crypto';

/** Stable 0–99 bucket from an id. Same id always lands in the same bucket. */
export function bucket100(id: string): number {
  const n = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16);
  return n % 100;
}

export function isSampled(id: string, pct: number): boolean {
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return bucket100(id) < pct;
}
