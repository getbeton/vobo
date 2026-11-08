import { Input, Label } from 'vobo';

const field = { display: 'grid', gap: 8, width: 320 };

export const Default = () => (
  <div style={field}>
    <Label htmlFor="q">Search tenders</Label>
    <Input id="q" placeholder="e.g. road maintenance, Kenya" />
  </div>
);

export const Filled = () => (
  <div style={field}>
    <Label htmlFor="email">Work email</Label>
    <Input id="email" type="email" defaultValue="anna@northwind.com" />
  </div>
);

export const Invalid = () => (
  <div style={field}>
    <Label htmlFor="email2">Work email</Label>
    <Input id="email2" type="email" aria-invalid defaultValue="anna@" />
    <p className="text-sm text-destructive">Enter a valid email address.</p>
  </div>
);

export const Disabled = () => (
  <div style={field}>
    <Label htmlFor="org">Company</Label>
    <Input id="org" disabled defaultValue="Northwind Ltd" />
  </div>
);
