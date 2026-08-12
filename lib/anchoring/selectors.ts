import search from 'approx-string-match';

/**
 * W3C-style dual anchor: TextQuoteSelector (quote + prefix + suffix) and
 * TextPositionSelector (start + end) over the markdown source string.
 * Quote+context is the durable half; position is the fast path and tiebreak.
 * (ARD §8; approach ported from the Hypothesis client's anchoring module.)
 */
export interface Selector {
  quote: string;
  prefix: string;
  suffix: string;
  startPos: number;
  endPos: number;
}

export interface AnchorMatch {
  start: number;
  end: number;
  /** 0 = exact. Edit-distance errors relative to quote length. */
  errorRatio: number;
  /** How well surrounding context (prefix/suffix) matched, 0..1. */
  contextScore: number;
}

const CONTEXT_LEN = 32;

/** Proportion of the quote allowed to differ before we stop trusting a match. */
const MAX_ERROR_RATIO = 0.25;

function contextSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const n = Math.min(a.length, b.length, CONTEXT_LEN);
  if (n === 0) return 0;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same / n;
}

/**
 * Locate `selector` in `text`. Strategy, in order:
 *  1. position selector, verified against the quote (exact);
 *  2. exact quote search (all occurrences, ranked by context);
 *  3. fuzzy quote search via approx-string-match, ranked by
 *     (errors, context mismatch, distance from original position).
 * Returns null when nothing survives MAX_ERROR_RATIO — the caller treats
 * that as an orphan. Never throws on arbitrary regenerated text.
 */
export function anchor(text: string, selector: Selector): AnchorMatch | null {
  const { quote } = selector;
  if (!quote) return null;

  // 1. Fast path: position still valid and quote unchanged there.
  if (
    selector.startPos >= 0 &&
    selector.endPos <= text.length &&
    text.slice(selector.startPos, selector.endPos) === quote
  ) {
    return {
      start: selector.startPos,
      end: selector.endPos,
      errorRatio: 0,
      contextScore: 1,
    };
  }

  const scoreCandidate = (start: number, end: number, errors: number): AnchorMatch => {
    const before = text.slice(Math.max(0, start - CONTEXT_LEN), start);
    const after = text.slice(end, end + CONTEXT_LEN);
    const prefixTail = selector.prefix.slice(-CONTEXT_LEN);
    const suffixHead = selector.suffix.slice(0, CONTEXT_LEN);
    // Compare prefix tails right-aligned, suffix heads left-aligned.
    const ctx =
      (contextSimilarity(
        before.split('').reverse().join(''),
        prefixTail.split('').reverse().join('')
      ) +
        contextSimilarity(after, suffixHead)) /
      2;
    return {
      start,
      end,
      errorRatio: errors / quote.length,
      contextScore: ctx,
    };
  };

  const candidates: AnchorMatch[] = [];

  // 2. Exact occurrences.
  let idx = text.indexOf(quote);
  while (idx !== -1) {
    candidates.push(scoreCandidate(idx, idx + quote.length, 0));
    idx = text.indexOf(quote, idx + 1);
  }

  // 3. Fuzzy occurrences.
  if (candidates.length === 0) {
    const maxErrors = Math.ceil(quote.length * MAX_ERROR_RATIO);
    const matches = search(text, quote, maxErrors);
    for (const m of matches) {
      candidates.push(scoreCandidate(m.start, m.end, m.errors));
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.errorRatio !== b.errorRatio) return a.errorRatio - b.errorRatio;
    if (a.contextScore !== b.contextScore) return b.contextScore - a.contextScore;
    return (
      Math.abs(a.start - selector.startPos) - Math.abs(b.start - selector.startPos)
    );
  });

  const best = candidates[0];
  return best.errorRatio <= MAX_ERROR_RATIO ? best : null;
}

/** Split markdown into paragraphs with their offsets (blank-line delimited). */
export function splitParagraphs(
  text: string
): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /\n\s*\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(last, m.index);
    if (chunk.trim()) out.push({ text: chunk, start: last, end: m.index });
    last = re.lastIndex;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ text: tail, start: last, end: text.length });
  return out;
}

export function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9$€%#.'’-]+/g) || [];
}

export function jaccard(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter++;
  });
  return inter / (A.size + B.size - inter);
}

export interface ParagraphPair {
  prevIndex: number | null;
  nextIndex: number | null;
  similarity: number;
}

/** Threshold below which paragraphs are not considered the same paragraph. */
export const PAIR_THRESHOLD = 0.34;

/** Greedy best-match pairing of previous-version paragraphs onto next-version. */
export function alignParagraphs(prev: string[], next: string[]): ParagraphPair[] {
  const used = new Set<number>();
  const pairs: ParagraphPair[] = [];
  prev.forEach((p, pi) => {
    let best = -1;
    let bestSim = 0;
    next.forEach((n, ni) => {
      if (used.has(ni)) return;
      const s = jaccard(p, n);
      if (s > bestSim) {
        bestSim = s;
        best = ni;
      }
    });
    if (best >= 0 && bestSim >= PAIR_THRESHOLD) {
      used.add(best);
      pairs.push({ prevIndex: pi, nextIndex: best, similarity: bestSim });
    } else {
      pairs.push({ prevIndex: pi, nextIndex: null, similarity: 0 });
    }
  });
  next.forEach((_, ni) => {
    if (!used.has(ni)) pairs.push({ prevIndex: null, nextIndex: ni, similarity: 0 });
  });
  return pairs;
}
