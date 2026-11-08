# Beton Council: how to build with it

shadcn/ui (new-york) components on the Beton Council tokens: white paper, slate neutrals,
**blue-600 (`#2563EB`) as the only accent**, 8px radius, Inter + Geist Mono.
Components are on `window.BetonCouncil` (Button, Card + Card* parts, Input, Label,
RadioGroup + RadioGroupItem, Avatar + AvatarImage/AvatarFallback, DropdownMenu + DropdownMenu* parts).

## Setup
- No provider or root wrapper is needed. Load `styles.css` (it imports the component CSS and the fonts).
- Dark mode: put `className="dark"` on an ancestor element.
- Compound parts only work inside their parent: `DropdownMenuItem` inside `DropdownMenuContent`
  inside `DropdownMenu`; `RadioGroupItem` inside `RadioGroup`; `CardHeader`/`CardContent`/`CardFooter` inside `Card`.

## Styling idiom
The stylesheet is a **static** Tailwind v4 build. Only classes that already appear in the source
exist. Do not invent Tailwind classes: `text-lg`, `text-2xl`, `rounded-lg`, `gap-4`, `p-6` and
many others are NOT in the CSS and render unstyled.

- Controls: use the components and their props. `Button` `variant`: `default` (primary, one per
  view) | `secondary` | `outline` | `ghost` | `link` | `destructive`; `size`: `sm` | `default` | `lg` | `icon`.
- Layout glue: use inline `style` with the design-system CSS variables:
  `var(--background)`, `var(--foreground)`, `var(--primary)`, `var(--primary-foreground)`,
  `var(--muted)`, `var(--muted-foreground)`, `var(--card)`, `var(--border)`, `var(--destructive)`,
  `var(--ring)`, `var(--radius)`, `var(--font-sans)`, `var(--font-mono)`.
- Verified utility classes you may use: `text-muted-foreground`, `text-foreground`, `text-destructive`,
  `bg-background`, `bg-card`, `bg-muted`, `text-xs`, `text-sm`, `text-base`, `text-3xl`,
  `font-medium`, `font-semibold`, `font-mono`, `flex`, `grid`, `items-center`, `justify-between`,
  `gap-2`, `gap-6`, `p-4`, `px-4`, `py-2`, `rounded-md`, `rounded-xl`, `border`, `shadow-xs`.

## Rules
- Blue-600 is the only accent. Green = status OK. Red = destructive or error only.
- Copy is left-aligned; headings are sentences in Inter 600; prices, ids and kickers in Geist Mono.
- One solid primary button per view; other actions use `outline`, `ghost` or `link`.

## Where the truth lives
- `styles.css` and its imports (`_ds_bundle.css`): every class and token that exists.
- `guidelines/design/beton-council-guidelines.md`: color, type and layout rules.
- `components/<group>/<Name>/<Name>.prompt.md` and `<Name>.d.ts`: per-component API.

## Example
```jsx
const { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button } = window.BetonCouncil;

<Card style={{ width: 380 }}>
  <CardHeader>
    <CardTitle>Road maintenance, Northern region</CardTitle>
    <CardDescription>Ministry of Transport · published 14 Sep 2026</CardDescription>
  </CardHeader>
  <CardContent>
    <p className="text-sm text-muted-foreground">Resurfacing works on 42 km of regional roads.</p>
  </CardContent>
  <CardFooter className="justify-between">
    <span className="font-mono text-sm">$1,240,000</span>
    <Button size="sm">View tender</Button>
  </CardFooter>
</Card>
```
