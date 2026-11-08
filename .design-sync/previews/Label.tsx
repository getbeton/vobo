import { Input, Label } from 'vobo';

export const WithInput = () => (
  <div style={{ display: 'grid', gap: 8, width: 320 }}>
    <Label htmlFor="title">Job title</Label>
    <Input id="title" placeholder="Head of public sector sales" />
  </div>
);
