import { describe, it, expect } from 'vitest';
import { classify, applyConfirmation } from '../classify';
import { anchor, splitParagraphs, alignParagraphs, Selector } from '../selectors';

// Test corpus mirrors the dogfood shape: a markdown email sequence.
const V1 = `Hi Dana, thanks for reaching out about your order 88213.

We sincerely apologize for any inconvenience caused and appreciate your patience and understanding during this time.

Good news — your purchase falls within our 60-day goodwill window, so you are fully eligible for a refund to your original payment method.

If there is anything else we can help with, please don’t hesitate to reach out.`;

function sel(doc: string, quote: string): Selector {
  const start = doc.indexOf(quote);
  if (start === -1) throw new Error('quote not in doc: ' + quote);
  return {
    quote,
    prefix: doc.slice(Math.max(0, start - 32), start),
    suffix: doc.slice(start + quote.length, start + quote.length + 32),
    startPos: start,
    endPos: start + quote.length,
  };
}

describe('anchor()', () => {
  it('finds an unchanged quote at its original position (exact fast path)', () => {
    const s = sel(V1, '60-day goodwill window');
    const m = anchor(V1, s)!;
    expect(m.start).toBe(s.startPos);
    expect(m.errorRatio).toBe(0);
  });

  it('finds a quote that moved (offset churn) via exact search + context', () => {
    const shifted = 'PREPENDED LINE\n\n' + V1;
    const s = sel(V1, '60-day goodwill window');
    const m = anchor(shifted, s)!;
    expect(shifted.slice(m.start, m.end)).toBe('60-day goodwill window');
  });

  it('survives whitespace/markdown-syntax churn via fuzzy match', () => {
    const s = sel(V1, 'your purchase falls within our 60-day goodwill window');
    const churned = V1.replace(
      'your purchase falls within our 60-day goodwill window',
      'your **purchase** falls within our 60-day  goodwill window'
    );
    const m = anchor(churned, s)!;
    expect(m).not.toBeNull();
    expect(m.errorRatio).toBeGreaterThan(0);
    expect(m.errorRatio).toBeLessThanOrEqual(0.25);
  });

  it('disambiguates duplicate quotes by prefix/suffix context', () => {
    const doc = 'alpha target beta\n\ngamma target delta';
    const s: Selector = {
      quote: 'target',
      prefix: 'gamma ',
      suffix: ' delta',
      startPos: doc.lastIndexOf('target'),
      endPos: doc.lastIndexOf('target') + 'target'.length,
    };
    // Break the position fast-path so context must decide.
    const moved = 'X ' + doc;
    const m = anchor(moved, { ...s, startPos: 0, endPos: 6 })!;
    expect(moved.slice(Math.max(0, m.start - 6), m.start)).toContain('gamma');
  });

  it('returns null when the quote is truly gone', () => {
    const s = sel(V1, '60-day goodwill window');
    const gone = V1.replace(
      'Good news — your purchase falls within our 60-day goodwill window, so you are fully eligible for a refund to your original payment method.',
      'Totally different paragraph now.'
    );
    expect(anchor(gone, s)).toBeNull();
  });
});

describe('classify()', () => {
  it('persisting (high) when the exact phrase survives in the paired paragraph', () => {
    const v2 = V1.replace('Hi Dana', 'Hello Dana'); // unrelated edit elsewhere
    const c = classify(sel(V1, '60-day goodwill window'), V1, v2);
    expect(c.state).toBe('persisting');
    expect(c.confidence).toBe('high');
    expect(c.landing).not.toBeNull();
  });

  it('resolved when the paragraph was edited in place (prototype v2 corpus)', () => {
    // The design prototype's own regeneration for this paragraph (REQ-207 v2).
    const v2 = V1.replace(
      'Good news — your purchase falls within our 60-day goodwill window, so you are fully eligible for a refund to your original payment method.',
      'Good news — you are fully eligible for a refund in store credit: your order was delivered 45 days ago, outside the 30-day window for your original payment method, but within the store-credit exception that runs to day 45.'
    );
    const c = classify(sel(V1, '60-day goodwill window'), V1, v2);
    expect(c.state).toBe('resolved');
    expect(c.landing).not.toBeNull();
    expect(c.landing!.quote).toContain('store credit');
  });

  it('orphaned (low) when the whole paragraph is deleted', () => {
    const v2 = V1.replace(
      '\n\nGood news — your purchase falls within our 60-day goodwill window, so you are fully eligible for a refund to your original payment method.',
      ''
    );
    const c = classify(sel(V1, '60-day goodwill window'), V1, v2);
    expect(c.state).toBe('orphaned');
    expect(c.confidence).toBe('low');
    expect(c.landing).toBeNull();
  });

  it('never crashes on a wholesale rewrite (force-push case) and stays honest', () => {
    const rewrite = `Completely new email.\n\nNothing from the old draft remains here at all.`;
    const c = classify(sel(V1, '60-day goodwill window'), V1, rewrite);
    expect(['orphaned', 'resolved']).toContain(c.state);
    expect(c.confidence).toBe('low');
  });

  it('resolved confidence degrades with paragraph similarity', () => {
    const lightEdit = V1.replace('60-day goodwill window', '30-day window');
    const heavyEdit = V1.replace(
      'Good news — your purchase falls within our 60-day goodwill window, so you are fully eligible for a refund to your original payment method.',
      'Good news — you are fully eligible for a refund in store credit: your order was delivered 45 days ago, outside the 30-day window for your original payment method, but within the store-credit exception that runs to day 45.'
    );
    const cLight = classify(sel(V1, '60-day goodwill window'), V1, lightEdit);
    const cHeavy = classify(sel(V1, '60-day goodwill window'), V1, heavyEdit);
    expect(cLight.state).toBe('resolved');
    expect(cHeavy.state).toBe('resolved');
    const rank = { high: 3, med: 2, low: 1 } as const;
    expect(rank[cLight.confidence]).toBeGreaterThan(rank[cHeavy.confidence]);
  });

  it('human overrides win: confirm-resolved and mark-persisting', () => {
    const v2 = V1.replace('Hi Dana', 'Hello Dana');
    const computed = classify(sel(V1, '60-day goodwill window'), V1, v2);
    expect(applyConfirmation(computed, 'res').state).toBe('resolved');
    expect(applyConfirmation(computed, 'per').state).toBe('persisting');
    expect(applyConfirmation(computed, null)).toEqual(computed);
  });
});

describe('paragraph machinery', () => {
  it('splitParagraphs preserves offsets', () => {
    const paras = splitParagraphs(V1);
    expect(paras.length).toBe(4);
    for (const p of paras) {
      expect(V1.slice(p.start, p.end)).toBe(p.text);
    }
  });

  it('alignParagraphs pairs edited paragraphs and reports orphans', () => {
    const prev = ['alpha beta gamma delta', 'unique paragraph here'];
    const next = ['alpha beta gamma DELTA edited', 'totally different words entirely'];
    const pairs = alignParagraphs(prev, next);
    const p0 = pairs.find((p) => p.prevIndex === 0)!;
    expect(p0.nextIndex).toBe(0);
    const p1 = pairs.find((p) => p.prevIndex === 1)!;
    expect(p1.nextIndex).toBeNull();
  });
});
