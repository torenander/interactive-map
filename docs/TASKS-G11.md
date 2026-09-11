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

Marks carry whose run they rest on. `[~]` is an implementer's watched run; `[x]` waits on
the lead's independent validation.

### src — draw-accuracy (commits 53d6b9d MapShell, cb80aaf RatingModal)

- [~] Cap the rating sheet's width, centred, matching the overlay sheet
      (`src/areas/RatingModal.tsx:71`, measured 1440 px wide at 1440x900)
      → `max-w-sm` + `mx-auto`. Measured after: sheet 384 px, Save button 352 px in a
      1440 px window.
- [~] Same treatment for the queued banner (`src/map/MapShell.tsx:1514`)
      → same cap and centring.
- [~] Escape resets MapShell session state, not only Terra Draw's store: clear
      `isDrawing` / `featureMode` / pending geometry (`MapShell.tsx:568`, `:601` — Terra
      Draw emits no cancel event, which is why the UI currently lies)
      → measured after: `finish-area` gone, `start-drawing` back, Terra Draw's store
      empty; same for line mode (`finish-line` / `start-line`) and point mode
      (`point-hint` / `start-point`).
- [~] Render a `cancel-drawing` control while a polygon is being drawn, as lines already
      have `cancel-feature`
      → `data-testid="cancel-drawing"`, the string the gate greps for, modelled on
      `cancel-feature`; verified present while drawing.
- [~] `instance.dragRotate.disable()` and `instance.touchPitch.disable()` after map
      creation — right-drag measured bearing 0 → -146.7, pitch 0 → 60, with no way back
      → measured after: right-drag leaves bearing 0 → 0 and pitch 0 → 0.
- [~] `RatingModal`: Escape dismisses, focus moves into the sheet on open, Tab stays
      inside it (measured: none of the three, and the first two tab stops are behind the
      sheet)
      → measured after: focus lands on the dialog, Tab cycles inside and reaches
      `save-area`, Escape closes.
- [~] Cursor `pointer` over saved areas, lines and points (measured `grab`; point mode's
      `crosshair` shows the mechanism already exists)
      → measured after: `pointer` over all three, `grab` over empty map, and still `grab`
      while brushing, so the cursor never fights a mode.
- [~] **Measure first, then decide:** whether `Enter` finishes a ring when the last click
      was a toolbar button rather than the canvas.
      → **Measured, and the answer was "implement", not "document".** `Enter` finishes
      when the last click was the canvas; after a toolbar click the button keeps focus and
      `Enter` *re-fires it*. With "Undo point" focused, `Enter` deleted a second vertex
      (ring 5 → 4) instead of finishing — destructive, not merely inert. Re-measured after
      the fix: focus blank, sheet opens, ring intact.

Gate evidence for the above, draw-accuracy's run: unit suite 88/88 exit 0; the `mobile`
project 33 passed, 0 failed.

**Correction, 2026-09-11 — raised by draw-accuracy against their own evidence, ruled on by
the lead.** The `preventScroll` line added with the focus work carried a causal claim its
runs did not support. Three points, which are the record:

1. **The fix stands, on mechanism alone.** `focus()` scrolls, the sheet sits at the bottom
   of the viewport, and a modal must not move the map under the pointer. It is a change
   you would make with no failure observed at all.
2. **The bisection claim in cb80aaf's message is retracted as confounded.** Every
   comparison varied configuration and the suspect line together — the line was present
   only in full parallel runs and absent only in isolated ones — so nothing was isolated.
   perf-probe later ran the missing cell (line unfixed, `--workers=1`, non-serial): green.
3. **Causal attribution is unresolved and immaterial, per the lead.** The configuration
   the failure appeared in — a full parallel two-project run — is no longer any gate's
   configuration now that the desktop lane is capped to `--workers=1`. No gate, no box and
   no shipped behaviour depends on the answer, so the decisive experiment is deliberately
   not being run.

Where the retracted wording still stands: the comment at `src/areas/RatingModal.tsx:64`
and cb80aaf's commit message. Commit messages are immutable history, so this annotation is
the correction — the same precedent as the `--workers=1` amendment — and a later reader
should trust the ledger over either.

Scope: the eight boxes above are unaffected. Each rests on a direct before/after
measurement of the behaviour it claims (cursor values, bearing and pitch, control
visibility, sheet width in pixels, the Tab sequence, ring length), not on this inference.
That holds for the `RatingModal` box too: its claims — focus lands on the dialog, Tab
cycles inside and reaches `save-area`, Escape closes — were each measured; it is the
`preventScroll` rationale *inside* that work, not the box's assertions, that this
correction touches. Box 8's `Enter` finding is likewise a measurement, not a deduction.

### tests and config — perf-probe (task #26)

- [ ] Derive `map-shell.spec.ts`'s two geometry assertions from the viewport (`:6` exact
      390x844, `:86` the `844 * 2/3` third)
- [ ] Add the `desktop` project to `playwright.config.ts`; extract tap/click into a shared
      input helper so the portable touch suites run under both
- [ ] Write `tests/e2e/desktop.spec.ts`

### close-out

- [ ] Run every `done_when` command; record outputs.
      Note the desktop line carries `--workers=1` as of the 2026-09-11 amendment in
      `docs/OBJECTIVES.md` § G11 (perf-probe's measurements, lead-approved): five
      consecutive single-worker runs were deterministic once the `perf-load` assertion
      defect fixed in b46323d is excluded, against 3 and 2 failures at 5 and 2 workers.
      Cost is 174-192 s against roughly 100 s.

---

## Frozen for revalidation

`src/*` is frozen at cb80aaf — draw-accuracy has committed to announcing before touching
it again, so perf-probe's determinism measurement has a still tree underneath it. The
eight `[~]` boxes above should therefore reproduce exactly against that commit; if one
does not, that is a real difference rather than the tree having moved under the run.

## Note for whoever reconciles run logs against this file

draw-accuracy's final two-project run showed one failure — `perf-load.spec.ts` on the
desktop project, asserting `<= 8` against 10 — that **will not reproduce**: the assertion
is not in the file on disk, and the stack pointed at a comment line, because perf-probe
was editing that spec while the run was in flight. Recorded so the log and the ledger can
be squared later; it is not a G11 regression, and it is not evidence for or against any
box above.
