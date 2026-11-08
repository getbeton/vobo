# design-sync notes (vobo -> Claude Design "Beton Council")

- Repo is a Next.js app, not a published package: no dist/, no .d.ts tree, no Storybook.
  `cfg.entry` points at a NON-existent `./.design-sync/no-dist.js` on purpose: it anchors the
  package dir at the repo root (converter otherwise looks for node_modules/vobo) and falls
  through to the synth entry from `components/ui` (`cfg.srcDir`).
- CSS: `cfg.buildCmd` compiles `.design-sync/ds-entry.css` (imports app/globals.css = Tailwind v4 +
  styles/beton-council + tw-animate-css) with the Tailwind CLI into `.design-sync/.cache/ds.css`
  (`cfg.cssEntry`). Re-run buildCmd BEFORE package-build whenever previews or components change:
  Tailwind only emits classes it finds in the scanned sources (`@source` components/ui + previews).
- Fonts: the app loads Inter/Geist Mono via next/font (no @font-face in the repo). ds-entry.css
  imports them from Google Fonts (same source as the vobo marketing templates). The Open Design
  project's fonts/*.woff2 are Vietnamese-only subsets - do not use them.
- Guidelines: default glob picked docs/vobo-mvp.md (product doc, not design). `cfg.guidelinesGlob`
  points at design/beton-council-guidelines.md (curated, brand-neutral visual rules).
- pnpm install prints "Ignored build scripts" (oxide, esbuild, sharp): harmless for this sync.
- Render check: user chose to skip Playwright on 2026-10-02. Validate runs with --no-render-check;
  cards were reviewed by the user in .review.html only.

## Re-sync risks
- Static Tailwind CSS: classes used only in new previews/components are missing until buildCmd re-runs.
- Google Fonts @import is network-fetched at render time.
- `entry` placeholder: if the repo ever adds a real build/dist, remove `cfg.entry` and use it.
- No machine render check has ever run on this bundle.
