/**
 * Working text is the base version plus applied suggestion chips, in
 * created-at order. Each applied row's start/end is against the text produced
 * by the previous applied rows. Pending chips overlay that string; they are
 * not folded until Accept.
 */

export type ManualEditStatus = 'pending' | 'applied' | 'rejected';

export interface ManualEditOp {
  startPos: number;
  endPos: number;
  replacement: string;
  status: ManualEditStatus;
}

export function applyManualEdits(base: string, rows: ManualEditOp[]): string {
  let text = base;
  for (const row of rows) {
    if (row.status !== 'applied') continue;
    if (row.startPos < 0 || row.endPos > text.length || row.startPos > row.endPos) continue;
    text = text.slice(0, row.startPos) + row.replacement + text.slice(row.endPos);
  }
  return text;
}

export function shiftMarks<T extends { startPos: number; endPos: number }>(
  marks: T[],
  edit: { startPos: number; endPos: number; replacement: string }
): { kept: T[]; orphaned: T[] } {
  const delta = edit.replacement.length - (edit.endPos - edit.startPos);
  const kept: T[] = [];
  const orphaned: T[] = [];
  for (const m of marks) {
    if (m.endPos <= edit.startPos) {
      kept.push(m);
    } else if (m.startPos >= edit.endPos) {
      kept.push({ ...m, startPos: m.startPos + delta, endPos: m.endPos + delta });
    } else {
      orphaned.push(m);
    }
  }
  return { kept, orphaned };
}
