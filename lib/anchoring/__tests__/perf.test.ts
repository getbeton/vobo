import { describe, it, expect } from 'vitest';
import { classify } from '../classify';
import { Selector } from '../selectors';

/**
 * Perf NFR guard (ARD §11): the re-anchoring pass for a realistic dogfood
 * artifact must stay far below human-perceptible latency. 50KB text with 50
 * anchors classifies in under 500ms on CI-class hardware.
 */
describe('re-anchoring performance budget', () => {
  it('50 anchors × 50KB artifact classify under 500ms', () => {
    const para = (i: number) =>
      `Paragraph ${i}: the quick brown fox number ${i} jumps over the lazy dog while reviewing anchored corrections about topic-${i} in a markdown email sequence that resembles production traffic.`;
    const prev = Array.from({ length: 250 }, (_, i) => para(i)).join('\n\n');
    // Regeneration: edit every 5th paragraph, delete every 50th.
    const next = Array.from({ length: 250 }, (_, i) => {
      if (i % 50 === 0) return null;
      if (i % 5 === 0) return para(i).replace('quick brown fox', 'slow crimson wolf');
      return para(i);
    })
      .filter(Boolean)
      .join('\n\n');

    expect(prev.length).toBeGreaterThan(45_000);

    const selectors: Selector[] = Array.from({ length: 50 }, (_, k) => {
      const i = k * 5;
      const quote = `the quick brown fox number ${i}`;
      const start = prev.indexOf(quote);
      return {
        quote,
        prefix: prev.slice(Math.max(0, start - 32), start),
        suffix: prev.slice(start + quote.length, start + quote.length + 32),
        startPos: start,
        endPos: start + quote.length,
      };
    });

    const t0 = performance.now();
    const results = selectors.map((s) => classify(s, prev, next));
    const elapsed = performance.now() - t0;

    expect(results.length).toBe(50);
    expect(results.every((r) => ['resolved', 'persisting', 'orphaned'].includes(r.state))).toBe(
      true
    );
    // eslint-disable-next-line no-console
    console.log(`classified 50 anchors over ${(prev.length / 1024).toFixed(0)}KB in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
