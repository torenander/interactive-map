# G11 — Desktop — task breakdown

**Goal:** The app is usable with a mouse and keyboard at 1440x900 — no unrecoverable
state, no surface stretched across the window, hover tells you what is clickable — with
mobile 390x844 still the primary target and every existing mobile gate green unchanged.
Exit criteria: `docs/OBJECTIVES.md` § G11.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G6.

**Sequencing:** implement after perf-probe's flakiness fix (task #22). The recon measured the
suite already intermittent under parallel load (three failures, then 27/27 on a re-run);
a second project adds contention, and a new gate should not inherit a known flake.

Drafted from two measured recon passes (layout/PWA/test-infra and mouse/keyboard
interactions). Every figure in the tasks below is measured, not estimated.

---

## Tasks

- [ ] Cap the rating sheet's width, centred, matching the overlay sheet
      (`src/areas/RatingModal.tsx:71`, measured 1440 px wide at 1440x900)
- [ ] Same treatment for the queued banner (`src/map/MapShell.tsx:1514`)
- [ ] Escape resets MapShell session state, not only Terra Draw's store: clear
      `isDrawing` / `featureMode` / pending geometry (`MapShell.tsx:568`, `:601` — Terra
      Draw emits no cancel event, which is why the UI currently lies)
- [ ] Render a `cancel-drawing` control while a polygon is being drawn, as lines already
      have `cancel-feature`
- [ ] `instance.dragRotate.disable()` and `instance.touchPitch.disable()` after map
      creation — right-drag measured bearing 0 → -146.7, pitch 0 → 60, with no way back
- [ ] `RatingModal`: Escape dismisses, focus moves into the sheet on open, Tab stays
      inside it (measured: none of the three, and the first two tab stops are behind the
      sheet)
- [ ] Cursor `pointer` over saved areas, lines and points (measured `grab`; point mode's
      `crosshair` shows the mechanism already exists)
- [ ] **Measure first, then decide:** whether `Enter` finishes a ring when the last click
      was a toolbar button rather than the canvas. Unknown, not assumed — a focused button
      may swallow the key before the adapter's canvas listener sees it.
- [ ] Derive `map-shell.spec.ts`'s two geometry assertions from the viewport (`:6` exact
      390x844, `:86` the `844 * 2/3` third)
- [ ] Add the `desktop` project to `playwright.config.ts`; extract tap/click into a shared
      input helper so the portable touch suites run under both
- [ ] Write `tests/e2e/desktop.spec.ts`
- [ ] Run every `done_when` command; record outputs
