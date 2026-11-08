# Beton Council: visual rules

Curated from the Beton Council design system (Open Design project "Vobo Design System",
tokens in `styles/beton-council/`). Brand-neutral: product voice, wordmark and imagery
rules stay with each product.

## Color

| Role | Token | Hex | Use |
| --- | --- | --- | --- |
| background | `--background` | `#ffffff` | page canvas |
| foreground | `--foreground` (slate-950) | `#0f172a` | body text and headings |
| primary | `--primary` (blue-600) | `#2563eb` | primary actions, links, focus ring. The only accent |
| surface | `--muted` / slate-50 | `#f8fafc` | cards, rails, sunken panels |
| muted text | `--muted-foreground` (slate-500) | `#64748b` | secondary text, metadata, kickers |
| border | `--border` (slate-200) | `#e2e8f0` | rules, input borders, hairlines |
| destructive | `--destructive` (red-500) | `#ef4444` | errors and destructive actions only |

Green is status-ok only. Red is never the brand accent.

## Type

- Inter (400/500/600/700) for UI, headings, body and display: `--font-sans`.
- Geist Mono (400-700) for prices, kickers, ids and code: `--font-mono`.
- Headings are sentences in Inter 600. Body measure 32em or less.

## Layout

- Radius 8px (`--radius`); border weight 1px.
- Spacing 4 / 8 / 12 / 16 / 24 / 32.
- Copy is left-aligned. No centered slogans.
- One solid primary button per viewport. Secondary actions use `outline`, `ghost` or `link`.
