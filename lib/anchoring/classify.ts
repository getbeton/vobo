import {
  Selector,
  anchor,
  splitParagraphs,
  alignParagraphs,
  jaccard,
} from './selectors';

/**
 * Classification of a prior annotation against a regenerated version.
 * Semantics are normative from the design prototype's classifyFinding +
 * ARD §8: persisting = the flagged content survived (the model ignored the
 * correction — surface loudly); resolved = the anchored content changed;
 * orphaned = its context is gone. Orphans are honest: never silently dropped.
 */

export type AnchorStateKind = 'resolved' | 'persisting' | 'orphaned';
export type Confidence = 'high' | 'med' | 'low';

export interface Classification {
  state: AnchorStateKind;
  confidence: Confidence;
  /** Landing spot on the new version; null when orphaned. */
  landing: { start: number; end: number; quote: string } | null;
}

/** Error ratio at/below which a fuzzy re-anchor still counts as "same text". */
const PERSIST_ERROR_RATIO = 0.1;
/** Context agreement required to trust a fuzzy persist. */
const PERSIST_CONTEXT = 0.6;

const simToConfidence = (sim: number): Confidence =>
  sim >= 0.75 ? 'high' : sim >= 0.5 ? 'med' : 'low';

/** Text-modality classifier. Other modalities plug in via `classifyFor`. */
export function classify(
  selector: Selector,
  prevText: string,
  nextText: string
): Classification {
  // 1. Try to re-anchor the quote itself on the new version.
  const match = anchor(nextText, selector);
  if (match) {
    const isSameText =
      match.errorRatio === 0 ||
      (match.errorRatio <= PERSIST_ERROR_RATIO && match.contextScore >= PERSIST_CONTEXT);
    if (isSameText) {
      return {
        state: 'persisting',
        confidence: match.errorRatio === 0 ? 'high' : 'med',
        landing: {
          start: match.start,
          end: match.end,
          quote: nextText.slice(match.start, match.end),
        },
      };
    }
  }

  // 2. Quote is gone (or too mangled to count as the same text): find the
  //    paragraph the annotation lived in and see whether it survived edit.
  const prevParas = splitParagraphs(prevText);
  const nextParas = splitParagraphs(nextText);
  const homeIndex = prevParas.findIndex(
    (p) => selector.startPos >= p.start && selector.startPos < p.end
  );

  if (homeIndex !== -1) {
    const pairs = alignParagraphs(
      prevParas.map((p) => p.text),
      nextParas.map((p) => p.text)
    );
    const pair = pairs.find((x) => x.prevIndex === homeIndex);
    if (pair && pair.nextIndex !== null) {
      const landingPara = nextParas[pair.nextIndex];
      return {
        state: 'resolved',
        confidence: simToConfidence(pair.similarity),
        landing: {
          start: landingPara.start,
          end: landingPara.end,
          quote: landingPara.text,
        },
      };
    }
    return { state: 'orphaned', confidence: 'low', landing: null };
  }

  // Selector position didn't map to any paragraph (defensive: corrupted or
  // out-of-range selector). If the document broadly resembles the previous
  // version, call it resolved-low; otherwise orphaned.
  const overall = jaccard(prevText, nextText);
  if (overall >= 0.5) {
    return { state: 'resolved', confidence: 'low', landing: null };
  }
  return { state: 'orphaned', confidence: 'low', landing: null };
}

/** Human overrides always win (confirm-resolved / mark-persisting). */
export type Confirmation = 'res' | 'per' | null;

export function applyConfirmation(
  computed: Classification,
  confirmation: Confirmation
): Classification {
  if (confirmation === 'res') return { ...computed, state: 'resolved', confidence: 'high' };
  if (confirmation === 'per') return { ...computed, state: 'persisting', confidence: 'high' };
  return computed;
}
