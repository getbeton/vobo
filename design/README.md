# Design reference — normative

`vobo-review-station.dc.html` is the interactive prototype exported from the
Claude Design project ([be7a8174](https://claude.ai/design/p/be7a8174-68cf-4168-b81a-5894ba7097ff?file=Vobo+Review+Station.dc.html)).
**The UI must be implemented verbatim from this file** — layout, copy,
keyboard shortcuts, states, and behavior. It is not a mood board.

How to read it:
- Screens are marked with `data-screen-label`: app shell, Reviewer queue,
  Workspace page, Project page, Queue page, Review workspace, Version compare.
- The `class Component extends DCLogic` block at the end is the **normative
  behavior spec**: approve gates (with exact user-facing reasons), verdict
  shipping, blind-N hold, re-pin/retire flows, escalation, toasts and alert
  copy. The verdict service and UI must match it.
- Templating: `sc-if` / `sc-for` / `{{ expr }}` bind to that component state.
- `x-import … BetonCouncilDesignSystem.Icon` = Lucide icon by kebab-case name
  (use `lucide-react` in the app).

Styling comes from `styles/beton-council/` (vendored verbatim from the same
project). Status-color semantics are load-bearing: persisting = loud red,
resolved = quiet green, orphaned = amber — never inverted.
