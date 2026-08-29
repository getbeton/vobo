import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  ReviewWorkspace,
  AnnotationData,
  CriterionData,
} from '../ReviewWorkspace';
import { remainingWork } from '@/lib/core/metrics';

/**
 * VOBO-231. PR #5 fixed three things a reviewer can only see on screen: the
 * pending selection stays marked, the composer scrolls into view, and the
 * textarea takes the cursor. All three shipped untested, because asserting
 * render behaviour needs a DOM.
 *
 * These run in the `component` vitest project (jsdom). The integration suite
 * keeps the node environment.
 */

const addComment = vi.fn(async (_payload: unknown) => ({
  ok: true as const,
  data: { annotationId: 'a1' },
}));
const editComment = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const resolveComment = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const setCriterion = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const confirmRes = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const persist = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const repin = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const retire = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const ship = vi.fn(async (_payload: unknown) => ({
  ok: true as const,
  data: { nextRequestId: null as string | null, nextLeaseMine: false },
}));
const claim = vi.fn(async () => ({ ok: true as const }));
const createSuggestion = vi.fn(async () => ({ ok: true as const, data: { suggestionId: 's1' } }));
const acceptSuggestion = vi.fn(async () => ({ ok: true as const }));
const rejectSuggestion = vi.fn(async () => ({ ok: true as const }));
const saveEdits = vi.fn(async () => ({ ok: true as const, data: { round: 2 } }));
const rerunJudge = vi.fn(async () => ({ ok: true as const }));
const routerPush = vi.fn();
const routerRefresh = vi.fn();

vi.mock('@/lib/actions/review', () => ({
  addCommentAction: (payload: unknown) => addComment(payload),
  editCommentAction: (...args: unknown[]) => editComment(...args),
  resolveCommentAction: (...args: unknown[]) => resolveComment(...args),
  setCriterionAction: (...args: unknown[]) => setCriterion(...args),
  confirmResolutionAction: (...args: unknown[]) => confirmRes(...args),
  markPersistingAction: (...args: unknown[]) => persist(...args),
  repinAction: (...args: unknown[]) => repin(...args),
  retireAction: (...args: unknown[]) => retire(...args),
  confirmFindingAction: async () => ({ ok: true }),
  dismissFindingAction: async () => ({ ok: true }),
  shipAction: (payload: unknown) => ship(payload),
  claimAction: (...args: unknown[]) => claim(...args),
  createSuggestionAction: (...args: unknown[]) => createSuggestion(...args),
  acceptSuggestionAction: (...args: unknown[]) => acceptSuggestion(...args),
  rejectSuggestionAction: (...args: unknown[]) => rejectSuggestion(...args),
  saveManualEditsAction: (...args: unknown[]) => saveEdits(...args),
  rerunJudgeAction: (...args: unknown[]) => rerunJudge(...args),
  gateAction: async () => ({ ok: true, data: { blocked: false, reasons: [], interstitials: [] } }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
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
  queueSlug: 'pico-cro-w2b-cold-email',
  projectSlug: 'pico',
  environment: 'production' as const,
  budgetExhausted: false,
  rejectCount: 0,
};

const QUEUE_HREF =
  '/queue?project=pico&queue=pico-cro-w2b-cold-email&env=production';
const NEXT_HREF =
  '/review/r2?project=pico&queue=pico-cro-w2b-cold-email&env=production';

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

function commentOnSelection(from: number, to: number) {
  selectInArtifact(from, to);
  fireEvent.keyDown(window, { key: 'm', code: 'KeyM', metaKey: true, shiftKey: true });
}

describe('ReviewWorkspace — the comment composer', () => {
  beforeEach(() => {
    addComment.mockClear();
    editComment.mockClear();
    setCriterion.mockClear();
    ship.mockClear();
  });

  it('marks the selected range without opening a comment', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    const marked = await screen.findByTitle(/type to suggest/i);
    expect(marked).toBeTruthy();
    expect(marked.getAttribute('style')).toContain('dashed');
    expect(marked.textContent).toBe('first claim');
    expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
  });

  it('Cmd+Shift+M opens the comment box in the right pane and focuses it', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTitle('Hide review pane'));
    expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
    commentOnSelection(4, 15);
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
      commentOnSelection(4, 15);
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
    commentOnSelection(4, 15);
    await screen.findByTitle('Selected — write the comment');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() =>
      expect(screen.queryByTitle('Selected — write the comment')).toBeNull()
    );
  });

  it('saves on Cmd+Enter with the captured range', async () => {
    renderWorkspace();
    commentOnSelection(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'This claim is not in the dossier.' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    const payload = addComment.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.body).toBe('This claim is not in the dossier.');
    expect(payload.startPos).toBe(4);
    expect(payload.endPos).toBe(15);
    // VOBO-222 removed the field; the client must not send it any more.
    expect(payload).not.toHaveProperty('expected');
  });

  it('saves on Ctrl+Enter too', async () => {
    renderWorkspace();
    commentOnSelection(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'Non-Mac keyboard.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
  });

  it('closes on Escape without saving', async () => {
    renderWorkspace();
    commentOnSelection(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'Never sent.' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull()
    );
    expect(addComment).not.toHaveBeenCalled();
  });

  it('Escape on composer then ⌘↵ ships after clearing the draft', async () => {
    renderWorkspace();
    commentOnSelection(4, 15);
    const box = await screen.findByPlaceholderText(/what’s wrong here/i);
    fireEvent.change(box, { target: { value: 'Never sent.' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull()
    );
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(ship.mock.calls[0][0]).toEqual(
      expect.objectContaining({ requestId: 'r1', kind: 'approve' })
    );
    expect(addComment).not.toHaveBeenCalled();
  });

  it('has no Expected input', async () => {
    renderWorkspace();
    commentOnSelection(4, 15);
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

describe('VOBO-291: Comment | Edit and suggestions', () => {
  beforeEach(() => {
    createSuggestion.mockClear();
    acceptSuggestion.mockClear();
    saveEdits.mockClear();
    ship.mockClear();
  });

  it('Correct manually is gone; select does not open a comment', async () => {
    renderWorkspace();
    expect(screen.queryByRole('button', { name: /Correct manually/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    selectInArtifact(4, 15);
    expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
    expect(await screen.findByTitle(/type to suggest/i)).toBeTruthy();
  });

  it('typing on a selection starts a replacement suggestion', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    fireEvent.keyDown(window, { key: 'o' });
    const box = await screen.findByPlaceholderText(/Replacement text/i);
    expect((box as HTMLTextAreaElement).value).toBe('o');
    expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
    fireEvent.change(box, { target: { value: 'opening line' } });
    fireEvent.click(screen.getByRole('button', { name: /^Suggest$/ }));
    await waitFor(() => expect(createSuggestion).toHaveBeenCalled());
    expect(createSuggestion.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        requestId: 'r1',
        startPos: 4,
        endPos: 15,
        replacement: 'opening line',
      })
    );
  });

  it('Backspace on a selection suggests deleting that span', async () => {
    renderWorkspace();
    selectInArtifact(4, 15);
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() => expect(createSuggestion).toHaveBeenCalled());
    expect(createSuggestion.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        requestId: 'r1',
        startPos: 4,
        endPos: 15,
        replacement: '',
      })
    );
  });

  it('Accept on a pending suggestion does not write a version', async () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        suggestions={[
          {
            id: 's1',
            startPos: 4,
            endPos: 15,
            originalQuote: 'first claim',
            replacement: 'opening line',
            status: 'pending',
          },
        ]}
      />
    );
    fireEvent.click(within(screen.getByTestId('suggestion-s1')).getByRole('button', { name: /^Accept$/ }));
    await waitFor(() => expect(acceptSuggestion).toHaveBeenCalledWith('r1', 's1'));
    expect(ship).not.toHaveBeenCalled();
    expect(saveEdits).not.toHaveBeenCalled();
  });

  it('applied suggestions arm Save manual edits; pending blocks it', () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        suggestions={[
          {
            id: 's1',
            startPos: 4,
            endPos: 15,
            originalQuote: 'first claim',
            replacement: 'opening line',
            status: 'applied',
          },
          {
            id: 's2',
            startPos: 20,
            endPos: 26,
            originalQuote: 'second',
            replacement: 'next',
            status: 'pending',
          },
        ]}
      />
    );
    const btn = screen.getByTestId('verdict-button') as HTMLButtonElement;
    expect(btn.textContent).toMatch(/Save manual edits/);
    expect(btn.disabled).toBe(true);
  });

  it('Save manual edits persists without shipping accept or reject', async () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        suggestions={[
          {
            id: 's1',
            startPos: 4,
            endPos: 15,
            originalQuote: 'first claim',
            replacement: 'opening line',
            status: 'applied',
          },
        ]}
      />
    );
    fireEvent.click(screen.getByTestId('verdict-button'));
    await waitFor(() => expect(saveEdits).toHaveBeenCalledWith('r1'));
    expect(ship).not.toHaveBeenCalled();
  });
});

describe('VOBO-269: review navigation keeps the working queue', () => {
  beforeEach(() => {
    ship.mockClear();
    claim.mockClear();
    routerPush.mockClear();
    claim.mockResolvedValue({ ok: true as const });
    ship.mockResolvedValue({
      ok: true as const,
      data: { nextRequestId: null as string | null, nextLeaseMine: false },
    });
  });

  it('Back to queue is the three-param href for this request’s queue', () => {
    renderWorkspace();
    expect(screen.getByRole('link', { name: /Back to queue/i }).getAttribute('href')).toBe(
      QUEUE_HREF
    );
  });

  it('last item: a verdict lands on that queue’s list, not bare /queue', async () => {
    renderWorkspace();
    fireEvent.click(screen.getByTestId('verdict-button'));
    await waitFor(() => expect(routerPush).toHaveBeenCalled());
    expect(routerPush).toHaveBeenCalledWith(QUEUE_HREF);
    expect(routerPush.mock.calls.flat()).not.toContain('/queue');
  });

  it('next item: opens that review with the three params', async () => {
    ship.mockResolvedValueOnce({
      ok: true as const,
      data: { nextRequestId: 'r2', nextLeaseMine: true },
    });
    renderWorkspace();
    fireEvent.click(screen.getByTestId('verdict-button'));
    await waitFor(() => expect(routerPush).toHaveBeenCalled());
    expect(routerPush).toHaveBeenCalledWith(NEXT_HREF);
  });

  it('claim race: lands on the same three-param list', async () => {
    ship.mockResolvedValueOnce({
      ok: true as const,
      data: { nextRequestId: 'r2', nextLeaseMine: false },
    });
    claim.mockResolvedValueOnce({
      ok: false as const,
      error: 'taken',
      code: 'claim_race',
    });
    renderWorkspace();
    fireEvent.click(screen.getByTestId('verdict-button'));
    await waitFor(() => expect(routerPush).toHaveBeenCalled());
    expect(routerPush).toHaveBeenCalledWith(QUEUE_HREF);
    expect(routerPush.mock.calls.flat()).not.toContain('/queue');
  });
});

const PREV = 'We sincerely apologize for the interruption.';

describe('VOBO-276: round 2+ opens split and accepts a comment on the current pane', () => {
  beforeEach(() => {
    addComment.mockClear();
    setCriterion.mockClear();
  });

  function renderRound2() {
    return render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 2 }}
        contentMd={CONTENT}
        previousContentMd={PREV}
        versionId="v2"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
      />
    );
  }

  it('round ≥ 2 shows previous left and current right', () => {
    renderRound2();
    expect(document.querySelector('[data-side="left"]')).toBeTruthy();
    expect(document.querySelector('[data-side="right"]')).toBeTruthy();
    expect(document.querySelector('[data-side="right"]')?.textContent).toContain('first claim');
  });

  it('round 1 stays a single pane', () => {
    renderWorkspace();
    expect(document.querySelector('[data-side="left"]')).toBeNull();
    expect(document.querySelector('[data-side="right"]')).toBeNull();
  });

  it('Current only restores the single pane of the current version', () => {
    renderRound2();
    fireEvent.click(screen.getByRole('button', { name: /Current only/i }));
    expect(document.querySelector('[data-side="left"]')).toBeNull();
    expect(screen.getByText(/first claim/)).toBeTruthy();
  });

  it('selecting on the right pane plus ⌘⇧M opens the composer', async () => {
    renderRound2();
    const pane = document.querySelector('[data-side="right"]') as HTMLElement;
    const seg = pane.querySelector('[data-seg-start]') as HTMLElement;
    const textNode = seg.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 15);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(seg);
    fireEvent.keyDown(window, { key: 'm', code: 'KeyM', metaKey: true, shiftKey: true });
    expect(await screen.findByPlaceholderText(/what’s wrong here/i)).toBeTruthy();
  });

  it('selecting on the left pane does not open the composer', () => {
    renderRound2();
    const pane = document.querySelector('[data-side="left"]') as HTMLElement;
    const seg = pane.querySelector('[data-seg-start]') as HTMLElement;
    const textNode = seg.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(seg);
    expect(screen.queryByPlaceholderText(/what’s wrong here/i)).toBeNull();
  });

  it('has no Compare link — the split is the station', () => {
    renderRound2();
    expect(screen.queryByRole('link', { name: /Compare/i })).toBeNull();
  });

  it('criteria stay on the split and can be scored', async () => {
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 2 }}
        contentMd={CONTENT}
        previousContentMd={PREV}
        versionId="v2"
        annotations={[]}
        criteria={[
          { id: 'c1', title: 'Voice', description: null, verdict: null },
        ]}
        files={[]}
      />
    );
    expect(document.querySelector('[data-side="right"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    await waitFor(() => expect(setCriterion).toHaveBeenCalledWith('r1', 'c1', 'pass'));
    expect(document.querySelector('[data-side="left"]')).toBeTruthy();
  });
});

const PRIOR: AnnotationData = {
  id: 'p1',
  body: 'Drop the apology.',
  expected: null,
  quote: 'sincerely',
  startPos: 3,
  endPos: 12,
  bornRound: 1,
  resolved: false,
  state: 'orphaned',
  confirmation: null,
};

describe('VOBO-278: prior findings live on the workspace rail', () => {
  beforeEach(() => {
    confirmRes.mockClear();
    addComment.mockClear();
    createSuggestion.mockClear();
  });

  function renderSplitWithPrior() {
    return render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 2 }}
        contentMd={CONTENT}
        previousContentMd={PREV}
        versionId="v2"
        annotations={[PRIOR]}
        criteria={CRITERIA}
        files={[]}
      />
    );
  }

  it('shows Resolved / Persists / Re-pin / Retire on a prior finding', () => {
    renderSplitWithPrior();
    expect(screen.getByRole('button', { name: /Resolved/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Persists/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Re-pin/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retire/i })).toBeTruthy();
  });

  it('Resolved confirms against the current version without leaving split', async () => {
    renderSplitWithPrior();
    fireEvent.click(screen.getByRole('button', { name: /Resolved/i }));
    await waitFor(() => expect(confirmRes).toHaveBeenCalledWith('r1', 'p1', 'v2'));
    expect(document.querySelector('[data-side="right"]')).toBeTruthy();
  });

  it('C with a live selection and a focused prior finding confirms, not type-to-suggest', async () => {
    createSuggestion.mockClear();
    renderSplitWithPrior();
    fireEvent.click(screen.getByText('Drop the apology.'));
    const pane = document.querySelector('[data-side="right"]') as HTMLElement;
    const seg = pane.querySelector('[data-seg-start]') as HTMLElement;
    const textNode = seg.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 15);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(seg);
    expect(await screen.findByTitle(/type to suggest/i)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'C' });
    await waitFor(() => expect(confirmRes).toHaveBeenCalledWith('r1', 'p1', 'v2'));
    expect(createSuggestion).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(/Replacement text/i)).toBeNull();
  });
});

const JUDGED: CriterionData[] = [
  {
    id: 'c1',
    key: 'voice',
    title: 'Voice',
    description: null,
    verdict: 'pass',
    source: 'machine',
    score: 0.91,
    finding: {
      startPos: 4,
      endPos: 15,
      passed: true,
      note: 'Voice matches the dossier.',
    },
  },
  {
    id: 'c2',
    key: 'factual',
    title: 'Factual',
    description: null,
    verdict: 'fail',
    source: 'machine',
    score: 0.12,
    finding: {
      startPos: CONTENT.indexOf('second'),
      endPos: CONTENT.indexOf('second') + 'second'.length,
      passed: false,
      note: 'Invented claim.',
    },
  },
];

function renderJudged(
  criteria: CriterionData[] = JUDGED,
  annotations: AnnotationData[] = []
) {
  return render(
    <ReviewWorkspace
      request={REQUEST}
      contentMd={CONTENT}
      versionId="v1"
      annotations={annotations}
      criteria={criteria}
      files={[]}
      machineReview={{ withheld: false, pending: false, failed: false, overallScore: 0.5 }}
    />
  );
}

describe('ReviewWorkspace — criterion cards', () => {
  beforeEach(() => {
    setCriterion.mockClear();
    ship.mockClear();
  });

  it('has Criteria and Comments, not a Machine review section', () => {
    renderJudged();
    expect(screen.queryByText('Machine review')).toBeNull();
    expect(screen.getByText('Criteria')).toBeTruthy();
    expect(screen.getByText('Comments')).toBeTruthy();
  });

  it('shows the title and 0–1 confidence while collapsed', () => {
    renderJudged();
    expect(screen.getByText('Voice')).toBeTruthy();
    expect(screen.getByTestId('confidence-c1').textContent).toBe('0.91');
    expect(screen.getByTestId('confidence-c2').textContent).toBe('0.12');
    expect(screen.queryByText('Voice matches the dossier.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pass' })).toBeNull();
  });

  it('unwraps to Pass / Fail / N/A so the human can override', () => {
    renderJudged();
    fireEvent.click(screen.getAllByTitle('Show criterion detail')[0]);
    expect(screen.getByText('Voice matches the dossier.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pass' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fail' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'N/A' })).toBeTruthy();
  });

  it('highlights the judged span when the criterion is hovered', async () => {
    renderJudged();
    fireEvent.mouseEnter(screen.getByTestId('criterion-c1'));
    const hl = await screen.findByTitle('Judge: pass');
    expect(hl.textContent).toBe('first claim');
    expect(hl.getAttribute('style')).toContain('green');
  });

  it('highlights a fail span in red', async () => {
    renderJudged();
    fireEvent.mouseEnter(screen.getByTestId('criterion-c2'));
    const hl = await screen.findByTitle('Judge: fail');
    expect(hl.textContent).toBe('second');
    expect(hl.getAttribute('style')).toContain('red');
  });

  it('focuses the first criterion card on load', async () => {
    renderJudged();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('criterion-c1')));
  });

  it('Enter marks pass and moves to the next criterion', async () => {
    renderJudged();
    const first = screen.getByTestId('criterion-c1');
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => expect(setCriterion).toHaveBeenCalledWith('r1', 'c1', 'pass'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('criterion-c2')));
  });

  it('Backspace marks fail and moves to the next criterion', async () => {
    renderJudged();
    const first = screen.getByTestId('criterion-c1');
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: 'Backspace' });
    await waitFor(() => expect(setCriterion).toHaveBeenCalledWith('r1', 'c1', 'fail'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('criterion-c2')));
  });
});

const VERSIONS = [
  { id: 'v1', number: 1, author: 'model', hash: 'aaaa1111' },
  { id: 'v2', number: 2, author: 'model', hash: 'bbbb2222' },
];

const ROUND2_COMMENT: AnnotationData = {
  ...OPEN_COMMENT,
  id: 'a2',
  bornRound: 2,
  body: 'Still invented.',
};

describe('VOBO-289: Accept can seal an older version', () => {
  beforeEach(() => ship.mockClear());

  it('shows a version selector defaulting to the current version', () => {
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 2 }}
        contentMd={CONTENT}
        previousContentMd={PREV}
        versionId="v2"
        versions={VERSIONS}
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
      />
    );
    const sel = screen.getByTitle('Accept version') as HTMLSelectElement;
    expect(sel.value).toBe('v2');
    expect(sel.querySelectorAll('option')).toHaveLength(2);
  });

  it('picking v1 with an open comment on v2 ships Accept of v1', async () => {
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 2 }}
        contentMd={CONTENT}
        previousContentMd={PREV}
        versionId="v2"
        versions={VERSIONS}
        annotations={[ROUND2_COMMENT]}
        criteria={CRITERIA}
        files={[]}
      />
    );
    expect(screen.getByTestId('verdict-button').textContent).toMatch(/Reject/);
    fireEvent.change(screen.getByTitle('Accept version'), { target: { value: 'v1' } });
    expect(screen.getByText(/Sealing version 1/)).toBeTruthy();
    expect(screen.getByTestId('verdict-button').textContent).toMatch(/Accept/);
    fireEvent.click(screen.getByTestId('verdict-button'));
    await waitFor(() => expect(ship).toHaveBeenCalled());
    expect(ship.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        requestId: 'r1',
        kind: 'approve',
        acceptedVersionId: 'v1',
      })
    );
  });

  it('round 1 with one version has no selector', () => {
    renderWorkspace();
    expect(screen.queryByTitle('Accept version')).toBeNull();
  });
});

describe('ReviewWorkspace — the single verdict button', () => {
  beforeEach(() => {
    ship.mockClear();
    setCriterion.mockClear();
  });

  it('shows Accept in green when every criterion passes and there is no comment', () => {
    renderJudged([
      { ...JUDGED[0], verdict: 'pass' },
      { ...JUDGED[1], verdict: 'pass', finding: { ...JUDGED[1].finding!, passed: true } },
    ]);
    const btn = screen.getByTestId('verdict-button');
    expect(btn.textContent).toMatch(/Accept/);
    expect(btn.getAttribute('style')).toContain('green');
    expect(screen.queryByText('Reject — rerun')).toBeNull();
  });

  it('shows Reject in red when a criterion is not pass', () => {
    renderJudged();
    const btn = screen.getByTestId('verdict-button');
    expect(btn.textContent).toMatch(/Reject/);
    expect(btn.getAttribute('style')).toContain('red');
  });

  it('shows Reject when there is an unresolved comment', () => {
    renderJudged(
      [
        { ...JUDGED[0], verdict: 'pass' },
        { ...JUDGED[1], verdict: 'pass', finding: { ...JUDGED[1].finding!, passed: true } },
      ],
      [OPEN_COMMENT]
    );
    expect(screen.getByTestId('verdict-button').textContent).toMatch(/Reject/);
  });

  it('Cmd+Enter ships accept when every criterion passes', async () => {
    renderJudged([
      { ...JUDGED[0], verdict: 'pass' },
      { ...JUDGED[1], verdict: 'pass', finding: { ...JUDGED[1].finding!, passed: true } },
    ]);
    const card = screen.getByTestId('criterion-c1');
    await waitFor(() => expect(document.activeElement).toBe(card));
    fireEvent.keyDown(card, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(ship.mock.calls[0][0]).toEqual(
      expect.objectContaining({ requestId: 'r1', kind: 'approve' })
    );
  });

  it('Cmd+Enter ships reject_corrections when a comment is open', async () => {
    renderJudged(
      [
        { ...JUDGED[0], verdict: 'pass' },
        { ...JUDGED[1], verdict: 'pass', finding: { ...JUDGED[1].finding!, passed: true } },
      ],
      [OPEN_COMMENT]
    );
    const card = screen.getByTestId('criterion-c1');
    await waitFor(() => expect(document.activeElement).toBe(card));
    fireEvent.keyDown(card, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(ship.mock.calls[0][0]).toEqual(
      expect.objectContaining({ requestId: 'r1', kind: 'reject_corrections' })
    );
  });

  it('Cmd+Enter ships reject_rerun when a criterion fails and there is no comment', async () => {
    renderJudged();
    const card = screen.getByTestId('criterion-c1');
    await waitFor(() => expect(document.activeElement).toBe(card));
    fireEvent.keyDown(card, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(ship.mock.calls[0][0]).toEqual(
      expect.objectContaining({ requestId: 'r1', kind: 'reject_rerun' })
    );
  });
});

describe('last-round reject', () => {
  beforeEach(() => ship.mockClear());

  it('Reject is enabled without scored criteria and ships reject_rerun', async () => {
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 3, roundBudget: 3, rejectCount: 2 }}
        contentMd={CONTENT}
        versionId="v3"
        annotations={[]}
        criteria={[{ id: 'c1', title: 'Voice', description: null, verdict: null }]}
        files={[]}
      />
    );
    const btn = screen.getByTestId('verdict-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/Reject/);
    expect(screen.getByText(/Last round/)).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(ship).toHaveBeenCalledTimes(1));
    expect(ship.mock.calls[0][0]).toEqual(
      expect.objectContaining({ requestId: 'r1', kind: 'reject_rerun' })
    );
  });
});

describe('VOBO-296: remaining work on the workspace top bar', () => {
  const work = remainingWork([
    ...Array.from({ length: 15 }, () => ({ status: 'accepted' })),
    ...Array.from({ length: 64 }, () => ({ status: 'open' })),
    ...Array.from({ length: 2 }, () => ({ status: 'claimed' })),
    ...Array.from({ length: 4 }, () => ({ status: 'rejected' })),
  ]);

  it('shows the same remaining/accepted pair as the queue', () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        remainingWork={work}
      />
    );
    const chip = screen.getByTestId('remaining-work');
    expect(chip.textContent).toBe('70 remaining · 15 accepted');
    expect(chip.getAttribute('title')).toContain('rejected 4');
    expect(screen.getByText('← Back to queue')).toBeTruthy();
  });

  it('after accept, remaining drops by one on refresh', () => {
    const after = remainingWork([
      ...Array.from({ length: 16 }, () => ({ status: 'accepted' })),
      ...Array.from({ length: 63 }, () => ({ status: 'open' })),
      ...Array.from({ length: 2 }, () => ({ status: 'claimed' })),
      ...Array.from({ length: 4 }, () => ({ status: 'rejected' })),
    ]);
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, status: 'accepted' }}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        remainingWork={after}
      />
    );
    expect(screen.getByTestId('remaining-work').textContent).toBe('69 remaining · 16 accepted');
  });
});

describe('VOBO-298: Rerun judge control', () => {
  beforeEach(() => {
    rerunJudge.mockClear();
  });

  it('shows Rerun judge when the current run is completed', () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        machineReview={{
          withheld: false,
          pending: false,
          failed: false,
          overallScore: 0.5,
          runState: 'completed',
          judgeEnabled: true,
        }}
      />
    );
    expect(screen.getByRole('button', { name: 'Rerun judge' })).toBeTruthy();
  });

  it('disables Rerun judge while the run is running', () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        machineReview={{
          withheld: false,
          pending: true,
          failed: false,
          overallScore: null,
          runState: 'running',
          judgeEnabled: true,
        }}
      />
    );
    expect((screen.getByRole('button', { name: 'Rerun judge' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('hides Rerun judge on an accepted request', () => {
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, status: 'accepted' }}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        machineReview={{
          withheld: false,
          pending: false,
          failed: false,
          overallScore: 0.5,
          runState: 'completed',
          judgeEnabled: true,
        }}
      />
    );
    expect(screen.queryByRole('button', { name: 'Rerun judge' })).toBeNull();
  });

  it('does not call rerun until the reviewer confirms', async () => {
    render(
      <ReviewWorkspace
        request={REQUEST}
        contentMd={CONTENT}
        versionId="v1"
        annotations={[]}
        criteria={CRITERIA}
        files={[]}
        machineReview={{
          withheld: false,
          pending: false,
          failed: false,
          overallScore: 0.5,
          runState: 'completed',
          judgeEnabled: true,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rerun judge' }));
    expect(rerunJudge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rerun' }));
    await waitFor(() =>
      expect(rerunJudge).toHaveBeenCalledWith({ requestId: 'r1', versionId: 'v1' })
    );
  });
});
