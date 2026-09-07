import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueueScreen } from '../QueueScreen';
import { remainingWork } from '@/lib/core/metrics';

/**
 * VOBO-296. The ranked list hides rejected rows. Remaining work still counts
 * them, so the header cannot derive the pair from `rows`.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/actions/review', () => ({
  archiveRequestsAction: async () => ({ ok: true }),
  claimAction: async () => ({ ok: true }),
  releaseAction: async () => ({ ok: true }),
}));

const CRO = remainingWork([
  ...Array.from({ length: 15 }, () => ({ status: 'accepted' })),
  ...Array.from({ length: 64 }, () => ({ status: 'open' })),
  ...Array.from({ length: 2 }, () => ({ status: 'claimed' })),
  ...Array.from({ length: 4 }, () => ({ status: 'rejected' })),
]);

describe('VOBO-296: remaining work on the queue header', () => {
  it('shows remaining and accepted for this queue+env', () => {
    render(<QueueScreen rows={[]} nextUp={null} miss={null} remainingWork={CRO} />);
    const chip = screen.getByTestId('remaining-work');
    expect(chip.textContent).toBe('70 remaining · 15 accepted');
    expect(chip.getAttribute('title')).toContain('open 64');
    expect(chip.getAttribute('title')).toContain('claimed 2');
    expect(chip.getAttribute('title')).toContain('rejected 4');
    expect(screen.getByText('Reviewer queue')).toBeTruthy();
  });

  it('still shows zeros when every live row is accepted', () => {
    const w = remainingWork([{ status: 'accepted' }, { status: 'accepted' }]);
    render(<QueueScreen rows={[]} nextUp={null} miss={null} remainingWork={w} />);
    expect(screen.getByTestId('remaining-work').textContent).toBe('0 remaining · 2 accepted');
    expect(screen.queryByTestId('remaining-work')).not.toBeNull();
  });
});
