import { Button } from 'vobo';

const row = { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const };

export const Variants = () => (
  <div style={row}>
    <Button>Start free</Button>
    <Button variant="secondary">Save search</Button>
    <Button variant="outline">Export CSV</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="link">View all tenders</Button>
    <Button variant="destructive">Delete list</Button>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Small</Button>
    <Button>Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Add">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
    </Button>
  </div>
);

export const Disabled = () => (
  <div style={row}>
    <Button disabled>Start free</Button>
    <Button variant="outline" disabled>Export CSV</Button>
  </div>
);
