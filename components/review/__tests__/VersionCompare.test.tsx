import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VersionCompare, FindingData } from '../VersionCompare';

/**
 * VOBO-280. Retire (X) and Re-pin (O) open a follow-up. Today the field does
 * not take focus, and Cmd+Enter still opens the verdict sheet. Tests first;
 * they must fail on current main / PR1.
 */

const retire = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const repin = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const gate = vi.fn(async () => ({
  ok: true as const,
  data: { blocked: false, reasons: [] as string[], interstitials: [] as string[] },
}));
const ship = vi.fn(async () => ({ ok: true as const }));
const confirm = vi.fn(async () => ({ ok: true as const }));
const persist = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/lib/actions/review', () => ({
  retireAction: (...args: unknown[]) => retire(...args),
  repinAction: (...args: unknown[]) => repin(...args),
  gateAction: (...args: unknown[]) => gate(...(args as [])),
  shipAction: (...args: unknown[]) => ship(...args),
  confirmResolutionAction: (...args: unknown[]) => confirm(...args),
  markPersistingAction: (...args: unknown[]) => persist(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const RIGHT = 'The apology is gone. A concrete value prop sits here instead.';
const LEFT = 'We sincerely apologize for the interruption.';

const FINDING: FindingData = {
  id: 'ann-1',
  body: 'Drop the apology.',
  expected: 'No apology.',
  quote: 'We sincerely apologize',
  startPos: 0,
  endPos: 22,
  bornRound: 1,
  resolvedComment: false,
  state: 'orphaned',
  confidence: 'low',
  confirmation: null,
  landing: null,
};

function renderCompare() {
  return render(
    <VersionCompare
      request={{
        id: 'r1',
        title: 'Dana — seq 2',
        round: 2,
        roundBudget: 3,
        status: 'claimed',
        budgetExhausted: false,
        projectSlug: 'pico',
        queueSlug: 'pico-cold-email',
        environment: 'production',
      }}
      left={{ number: 1, content: LEFT, author: 'model', hash: 'aaaa1111', id: 'v1' }}
      right={{ number: 2, content: RIGHT, author: 'model', hash: 'bbbb2222', id: 'v2' }}
      versions={[
        { number: 1, author: 'model', hash: 'aaaa1111', human: false },
        { number: 2, author: 'model', hash: 'bbbb2222', human: false },
      ]}
      findings={[FINDING]}
      criteriaScored={true}
      unscoredCount={0}
    />
  );
}

function cmdEnter(target: Element = document.body) {
  fireEvent.keyDown(target, { key: 'Enter', metaKey: true });
}

function press(key: string, target: Element = document.body) {
  fireEvent.keyDown(target, { key });
}

describe('VOBO-280: corrections pane focuses the follow-up and Cmd+Enter saves it', () => {
  beforeEach(() => {
    retire.mockClear();
    repin.mockClear();
    gate.mockClear();
    ship.mockClear();
    confirm.mockClear();
    persist.mockClear();
  });

  it('Retire focuses the reason field', async () => {
    renderCompare();
    fireEvent.click(screen.getByRole('button', { name: /Retire/i }));
    const input = screen.getByPlaceholderText(/Retire reason/i);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('X on the card focuses the reason field', async () => {
    renderCompare();
    press('x');
    const input = screen.getByPlaceholderText(/Retire reason/i);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('Cmd+Enter retires with the typed reason and does not open the verdict sheet', async () => {
    renderCompare();
    fireEvent.click(screen.getByRole('button', { name: /Retire/i }));
    const input = screen.getByPlaceholderText(/Retire reason/i);
    fireEvent.change(input, { target: { value: 'not relevant anymore' } });
    cmdEnter(input);

    await waitFor(() => expect(retire).toHaveBeenCalled());
    expect(retire.mock.calls[0][0]).toBe('r1');
    expect(retire.mock.calls[0][1]).toBe('ann-1');
    expect(retire.mock.calls[0][2]).toBe('not relevant anymore');
    expect(gate).not.toHaveBeenCalled();
  });

  it('Cmd+Enter does not ship while the reason field is open and empty', () => {
    renderCompare();
    fireEvent.click(screen.getByRole('button', { name: /Retire/i }));
    cmdEnter();
    expect(retire).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
  });

  it('Escape cancels the reason field and does not retire', () => {
    renderCompare();
    fireEvent.click(screen.getByRole('button', { name: /Retire/i }));
    const input = screen.getByPlaceholderText(/Retire reason/i);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/Retire reason/i)).toBeNull();
    expect(retire).not.toHaveBeenCalled();
  });

  it('Re-pin focuses follow-up; Cmd+Enter commits re-pin, not ship', async () => {
    renderCompare();
    fireEvent.click(screen.getByRole('button', { name: /Re-pin/i }));
    expect(screen.getByText(/Re-pin mode/i)).toBeTruthy();

    const pane = document.querySelector('[data-side="right"]') as HTMLElement;
    expect(pane).toBeTruthy();
    const seg = pane.querySelector('[data-seg-start]') as HTMLElement;
    const textNode = seg.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    cmdEnter();

    await waitFor(() => expect(repin).toHaveBeenCalled());
    expect(gate).not.toHaveBeenCalled();
  });
});
