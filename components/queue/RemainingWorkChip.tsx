import { remainingWorkLabel, remainingWorkTitle, type RemainingWork } from '@/lib/core/metrics';

/** Queue + workspace share one remaining/accepted chip. */
export function RemainingWorkChip({ work }: { work: RemainingWork }) {
  return (
    <span
      data-testid="remaining-work"
      title={remainingWorkTitle(work)}
      style={{ fontSize: 13, color: 'var(--slate-500)', fontWeight: 500 }}
    >
      {remainingWorkLabel(work)}
    </span>
  );
}
