import { describe, it, expect } from 'vitest';
import { applyManualEdits, shiftMarks, type ManualEditOp } from '../manual-edits';

const BASE = 'The first claim is invented. The second paragraph is fine.';

describe('VOBO-291: applyManualEdits', () => {
  it('replays applied rows in order onto the base', () => {
    const rows: ManualEditOp[] = [
      { startPos: 4, endPos: 15, replacement: 'opening line', status: 'applied' },
      { startPos: 12, endPos: 16, replacement: 'bit', status: 'applied' },
    ];
    // After first: 'The opening line is invented. The second paragraph is fine.'
    // Second was stored against that working text: 'line' at 12-16 → 'bit'
    expect(applyManualEdits(BASE, rows)).toBe(
      'The opening bit is invented. The second paragraph is fine.'
    );
  });

  it('ignores pending and rejected rows', () => {
    const rows: ManualEditOp[] = [
      { startPos: 0, endPos: 3, replacement: 'A', status: 'pending' },
      { startPos: 4, endPos: 9, replacement: 'X', status: 'rejected' },
    ];
    expect(applyManualEdits(BASE, rows)).toBe(BASE);
  });

  it('shifts later marks by the replacement delta', () => {
    const comment = { startPos: 40, endPos: 50 };
    const { kept, orphaned } = shiftMarks([comment], {
      startPos: 0,
      endPos: 5,
      replacement: 'Hello!!',
    });
    expect(orphaned).toEqual([]);
    const delta = 'Hello!!'.length - 5;
    expect(kept).toEqual([{ startPos: 40 + delta, endPos: 50 + delta }]);
  });

  it('orphans a mark that overlaps the replacement', () => {
    const comment = { startPos: 50, endPos: 70 };
    const { kept, orphaned } = shiftMarks([comment], {
      startPos: 40,
      endPos: 60,
      replacement: 'x',
    });
    expect(kept).toEqual([]);
    expect(orphaned).toEqual([comment]);
  });

  it('does not shift a mark wholly before the replacement', () => {
    const comment = { startPos: 0, endPos: 3 };
    const { kept, orphaned } = shiftMarks([comment], {
      startPos: 10,
      endPos: 15,
      replacement: 'zz',
    });
    expect(orphaned).toEqual([]);
    expect(kept).toEqual([comment]);
  });
});
