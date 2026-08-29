import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  ReviewWorkspace,
  AnnotationData,
  CriterionData,
} from '../ReviewWorkspace';

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

describe('ReviewWorkspace — the comment composer', () => {
  beforeEach(() => {
    addComment.mockClear();
    editComment.mockClear();
    setCriterion.mockClear();
    ship.mockClear();
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
    const payload = addComment.mock.calls[0][0] as Record<string, unknown>;
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

function typeInEditor(text: string) {
  const box = document.querySelector('[contenteditable]') as HTMLElement;
  expect(box, 'edit mode renders a contenteditable').toBeTruthy();
  box.innerText = text;
}

describe('VOBO-282: human save in edit mode', () => {
  beforeEach(() => ship.mockClear());

  it('ships approve_edited with the artifact text even on the last policy round', async () => {
    render(
      <ReviewWorkspace
        request={{ ...REQUEST, round: 3, roundBudget: 3 }}
        contentMd={CONTENT}
        versionId="v3"
        annotations={[]}
        criteria={[{ id: 'c1', title: 'Voice', description: null, verdict: null }]}
        files={[]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Correct manually/i }));
    typeInEditor(CONTENT);
    fireEvent.click(screen.getByRole('button', { name: /Save as human version/i }));
    await waitFor(() => expect(ship).toHaveBeenCalled());
    expect(ship.mock.calls[0][0]).toMatchObject({
      requestId: 'r1',
      kind: 'approve_edited',
      editedContentMd: CONTENT,
    });
  });

  it('keeps edit mode and shows the API reason when save fails', async () => {
    ship.mockResolvedValueOnce({
      ok: false as const,
      error: 'Score all criteria to proceed — 1 left',
      code: 'criteria_unscored',
    });
    renderWorkspace();
    fireEvent.click(screen.getByRole('button', { name: /Correct manually/i }));
    typeInEditor(CONTENT);
    fireEvent.click(screen.getByRole('button', { name: /Save as human version/i }));
    await waitFor(() => expect(screen.getByText(/Score all criteria to proceed — 1 left/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Save as human version/i })).toBeTruthy();
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

  it('selecting on the right pane opens the composer', async () => {
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
