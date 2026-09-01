import { classify as classifyText, type Classification } from '@/lib/anchoring/classify';
import type { Selector } from '@/lib/anchoring/selectors';

/**
 * Per-modality selector engine. Text is the built-in; other modalities
 * `registerSelector` without changing this file or `classify.ts`.
 */
export interface SelectorEngine {
  classify(selector: unknown, prev: string, next: string): Classification;
}

const engines = new Map<string, SelectorEngine>();

export function registerSelector(id: string, engine: SelectorEngine): void {
  engines.set(id, engine);
}

export function getSelector(id: string): SelectorEngine {
  const engine = engines.get(id);
  if (!engine) {
    throw new Error(`No selector engine registered for modality '${id}'`);
  }
  return engine;
}

export function classifyFor(
  modality: string,
  selector: unknown,
  prev: string,
  next: string
): Classification {
  return getSelector(modality).classify(selector, prev, next);
}

registerSelector('text', {
  classify: (selector, prev, next) => classifyText(selector as Selector, prev, next),
});
