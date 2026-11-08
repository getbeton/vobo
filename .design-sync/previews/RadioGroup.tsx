import { Label, RadioGroup, RadioGroupItem } from 'vobo';

const opt = { display: 'flex', alignItems: 'center', gap: 8 };

export const Plans = () => (
  <RadioGroup defaultValue="monthly" style={{ width: 320 }}>
    <div style={opt}>
      <RadioGroupItem value="pass" id="r-pass" />
      <Label htmlFor="r-pass">3-day pass · $19 once</Label>
    </div>
    <div style={opt}>
      <RadioGroupItem value="monthly" id="r-monthly" />
      <Label htmlFor="r-monthly">Monthly · $49 / month</Label>
    </div>
    <div style={opt}>
      <RadioGroupItem value="annual" id="r-annual" />
      <Label htmlFor="r-annual">Annual · $499 / year</Label>
    </div>
  </RadioGroup>
);

export const Disabled = () => (
  <RadioGroup defaultValue="csv" disabled>
    <div style={opt}>
      <RadioGroupItem value="csv" id="r-csv" />
      <Label htmlFor="r-csv">CSV</Label>
    </div>
    <div style={opt}>
      <RadioGroupItem value="json" id="r-json" />
      <Label htmlFor="r-json">JSON</Label>
    </div>
  </RadioGroup>
);
