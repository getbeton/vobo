import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewWorkspace, AnnotationData, CriterionData } from '../ReviewWorkspace';

/**
 * VOBO-231. PR #5 fixed three things a reviewer can only see on screen: the
 * pending selection stays marked, the composer scrolls into view, and the
 * textarea takes the cursor. All three shipped untested, because asserting
 * render behaviour needs a DOM.
 *
 * These run in the `component` vitest project (jsdom). The integration suite
 * keeps the node environment.
 */

const addComment = vi.fn(async () => ({ ok: true as const, data: { annotationId: 'a1' } }));
const editComment = vi.fn(async () => ({ ok: true as const }));
const resolveComment = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/lib/actions/review', () => ({
  addCommentAction: (...args: unknown[]) => addComment(...(args as [])),
  editCommentAction: (...args: unknown[]) => editComment(...(args as [])),
  resolveCommentAction: (...args: unknown[]) => resolveComment(...(args as [])),
  setCriterionAction: async () => ({ ok: true }),
  confirmFindingAction: async () => ({ ok: true }),
  dismissFindingAction: async () => ({ ok: true }),
  shipAction: async () => ({ ok: true }),
  gateAction: async () => ({ ok: true, data: { blocked: false, reasons: [], interstitials: [] } }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const CONTENT = 'The first claim is invented.\n\nThe second paragraph is fine.';

const REQUEST = {
  id: 'r1',
  title: 'Kate Williams — step 1',
  status: 'claimed',
  round: 1,
  prompt: 'Voice: direct.',
  source: 'Account pass.',
  policyLabel: 'policy v1',
  roundBudget: 3,
  queueSlug: 'pico-cold-email',
  projectSlug: 'pico',
  budgetExhausted: false,
};

const CRITERIA: CriterionData[] = [
  { id: 'c1', title: 'Voice', description: null, verdict: 'pass' },
];

function renderWorkspace(annotations: AnnotationData[] = []) {
  return render(
    <ReviewWorkspace
      request={REQUEST}
      contentMd={CONTENT}
      versionId="v1"
      annotations={annotations}
      criteria={CRITERIA}
      files={[]}
    />
  );
}

/**
 * Drive a real selection across the artifact. `captureSelection` walks up to
 * the nearest element carrying `data-seg-start`, so the selection has to land
 * inside a rendered segment, not on a synthetic object.
 */
function selectInArtifact(from: number, to: number) {
  const seg = document.querySelector('[data-seg-start]') as HTMLElement;
  expect(seg, 'the artifact renders at least one segment').toBeTruthy();
  const textNode = seg.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(seg);
}

describe('ReviewWorkspace — the comment composer', () => {
  beforeEach(() => {
    addComment.mockClear();
    editComment.mockClear();
  });

  it('marks the selected range while the composer is open', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    const marked = await screen.findByTitle('Selected — write the comment');
    expect(marked).toBeTruthy();
    // Amber and dashed, so it does not read as a saved annotation.
    expect(marked.getAttribute('style')).toContain('dashed');
    expect(marked.textContent).toBe('first claim');
    expect(marked.textContent).toBe(CONTENT.slice(4, 15));
  });

  it('puts the cursor in the comment box', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTitle('Hide review pane'));
    expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
    selectInArtifact(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    expect(box).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('scrolls the composer into view', async () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      renderWorkspace();
      fireEvent.click(screen.getByTitle('Hide review pane'));
      expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
      selectInArtifact(4, 15);
      const box = await screen.findByPlaceholderText(/what’s wrong here/i);
      expect(box).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(box));
      await waitFor(() => expect(spy).toHaveBeenCalled());
      expect(spy.mock.instances).toContain(box);
      const idx = spy.mock.instances.indexOf(box);
      expect(spy.mock.calls[idx][0]).toEqual({ block: 'center', behavior: 'smooth' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('clears the mark when the composer closes', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    await screen.findByTitle('Selected — write the comment');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() =>
      expect(screen.queryByTitle('Selected — write the comment')).toBeNull()
    );
  });

  it('saves on Cmd+Enter with the captured range', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'This claim is not in the dossier.' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    const payload = addComment.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(payload.body).toBe('This claim is not in the dossier.');
    expect(payload.startPos).toBe(4);
    expect(payload.endPos).toBe(15);
    // VOBO-222 removed the field; the client must not send it any more.
    expect(payload).not.toHaveProperty('expected');
  });

  it('saves on Ctrl+Enter too', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'Non-Mac keyboard.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
  });

  it('closes on Escape without saving', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'Never sent.' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull()
    );
    expect(addComment).not.toHaveBeenCalled();
  });

  it('has no Expected input', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    await screen.findByPlaceholderText(/what’s wrong here/i);
    expect(screen.queryByPlaceholderText(/Expected/i)).toBeNull();
  });
});

const OPEN_COMMENT: AnnotationData = {
  id: 'a1',
  body: 'Invented customer.',
  expected: null,
  quote: 'first claim',
  startPos: 4,
  endPos: 15,
  bornRound: 1,
  resolved: false,
  state: null,
  confirmation: null,
};

describe('ReviewWorkspace — editing a comment', () => {
  beforeEach(() => editComment.mockClear());

  it('opens an edit box holding the current body', async () => {
    renderWorkspace([OPEN_COMMENT]);
    fireEvent.click(screen.getByTitle('Edit this comment'));
    const box = (await screen.findByDisplayValue('Invented customer.')) as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
  });

  it('saves the edit on Cmd+Enter', async () => {
    renderWorkspace([OPEN_COMMENT]);
    fireEvent.click(screen.getByTitle('Edit this comment'));
    const box = await screen.findByDisplayValue('Invented customer.');
    fireEvent.change(box, { target: { value: 'Not in the dossier.' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(editComment).toHaveBeenCalledTimes(1));
    expect(editComment.mock.calls[0]).toEqual(['r1', 'a1', 'Not in the dossier.']);
  });

  it('refuses to save an unchanged body', async () => {
    renderWorkspace([OPEN_COMMENT]);
    fireEvent.click(screen.getByTitle('Edit this comment'));
    await screen.findByDisplayValue('Invented customer.');
    const save = screen.getByText(/^Save/) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('offers no edit control on a resolved comment', () => {
    renderWorkspace([{ ...OPEN_COMMENT, resolved: true }]);
    expect(screen.queryByTitle('Edit this comment')).toBeNull();
  });

  it('still renders an Expected value written before the field was removed', () => {
    renderWorkspace([{ ...OPEN_COMMENT, expected: 'Name a real customer.' }]);
    expect(screen.getByText(/Expected: Name a real customer\./)).toBeTruthy();
  });
});
