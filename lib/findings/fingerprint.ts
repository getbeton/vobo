import { createHash } from 'crypto';

/** Collapse whitespace and case so the same span re-raises as the same finding. */
export function normalizeQuote(quote: string): string {
  return quote.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Per-request dismissal key: criterion + normalized quote. Producer is not part of it. */
export function findingFingerprint(criterionKey: string, quote: string): string {
  return createHash('sha256')
    .update(`${criterionKey}\n${normalizeQuote(quote)}`)
    .digest('hex');
}

const CONTEXT = 32;

export function quoteContext(content: string, startPos: number, endPos: number) {
  return {
    quote: content.slice(startPos, endPos),
    prefix: content.slice(Math.max(0, startPos - CONTEXT), startPos),
    suffix: content.slice(endPos, endPos + CONTEXT),
  };
}

/**
 * Locate a quote in the artifact. Exact first, then case-insensitive.
 * Returns offsets in `content`; the caller must slice those offsets for the
 * stored quote so ingest can validate against the real bytes.
 */
export function locateQuote(
  content: string,
  quote: string
): { startPos: number; endPos: number } | null {
  if (!quote) return null;
  const exact = content.indexOf(quote);
  if (exact >= 0) return { startPos: exact, endPos: exact + quote.length };
  const idx = content.toLowerCase().indexOf(quote.toLowerCase());
  if (idx < 0) return null;
  return { startPos: idx, endPos: idx + quote.length };
}
