import { describe, it, expect } from 'vitest';
import { classifyFor, getRenderer, getSelector, registerModality } from '@/lib/modality';
import { classify } from '@/lib/anchoring/classify';
import type { Selector } from '@/lib/anchoring/selectors';

/**
 * VOBO-189: a fourth modality is a registry entry, not a core-file edit.
 * This file is the proof — it never patches classify.ts, schema, or the pages.
 */

const V1 = 'Hi Dana, thanks for reaching out about your order 88213.';

function sel(doc: string, quote: string): Selector {
  const start = doc.indexOf(quote);
  return {
    quote,
    prefix: doc.slice(Math.max(0, start - 32), start),
    suffix: doc.slice(start + quote.length, start + quote.length + 32),
    startPos: start,
    endPos: start + quote.length,
  };
}

describe('modality registry', () => {
  it('a no-op fourth modality registers without touching a core file', () => {
    const Noop = () => null;
    registerModality({
      id: 'noop',
      ReviewPane: Noop,
      ComparePane: Noop,
      classify: () => ({ state: 'orphaned', confidence: 'low', landing: null }),
    });

    expect(getRenderer('noop').ReviewPane).toBe(Noop);
    expect(getSelector('noop').classify({}, 'a', 'b')).toEqual({
      state: 'orphaned',
      confidence: 'low',
      landing: null,
    });
    expect(classifyFor('noop', {}, 'prev', 'next')).toEqual({
      state: 'orphaned',
      confidence: 'low',
      landing: null,
    });
  });

  it('text engine still classifies through the selector abstraction', () => {
    const s = sel(V1, 'order 88213');
    expect(classifyFor('text', s, V1, V1)).toEqual(classify(s, V1, V1));
    expect(classifyFor('text', s, V1, V1).state).toBe('persisting');
  });
});
