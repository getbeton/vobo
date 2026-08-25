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

/** Locate a verbatim quote in the artifact. Exact match only — unanchorable is dropped. */
export function locateQuote(
  content: string,
  quote: string
): { startPos: number; endPos: number } | null {
  if (!quote) return null;
  const idx = content.indexOf(quote);
  if (idx < 0) return null;
  return { startPos: idx, endPos: idx + quote.length };
}
