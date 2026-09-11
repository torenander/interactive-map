# G8 — Brush painting of H3 cells — task breakdown

**Goal:** Paint an area by dragging a finger — touched res-10 H3 cells accumulate, the
selection becomes one polygon on release, and that polygon saves through `save-area` like
a drawn one. Exit criteria: `docs/OBJECTIVES.md` § G8.

State markers: `[ ]` not complete, `[~]` needs review, `[x]` done (only after
watching the commands run) — see `docs/TASKS.md` for the full legend.

Blocked by G3, G6 — the brush must not be built on a drawing pipeline that G6 is still
changing.

---

## Stages

The pure core landed first, in this worktree. MapShell wiring waits for the file to
clear (G7 stage 2 holds it), so every box below is marked against the stage it belongs
to. `[~]` is as far as agent work goes in this repo — `[x]` is reserved for a human
review pass, per `docs/TASKS.md`.

## Tasks

- [~] Promote `h3-js` from `devDependencies` to `dependencies` (today it is test/edge-function only).
      Done: `npm install h3-js@^4.5.0 --save-prod`, version unchanged, lockfile diff is
      only the dropped `dev` flag. `src/map/brush.ts` imports it, so it is shipped code now.
- [~] Brush mode: pointer-down opens a session, every `pointermove` adds `latLngToCell` at res 10, pointer-up closes it. Sample every move event rather than throttling to frames and dropping cells.
      Core: `beginStroke` / `extendStroke` / `endStroke`, one stamp per call, no
      throttling, and `extendStroke` throws without an open stroke. Wiring: canvas
      pointer handlers registered only while brush mode is active, so they and Terra
      Draw never listen at once. Gaps between move events are filled with `pixelPath`
      at a zoom-derived step, and the release position is painted through to — the
      browser coalesces moves, and without that a 180px stroke painted only ~130px.
- [~] Render the live selection as its own source, distinct from saved-area fill.
      `brush-selection` source with its own fill and line layers, blue and dashed, added
      after the saved-area layers so paint sits on top. Nothing in it is rating-coloured
      and nothing about it is in `saved-areas`, so a selection cannot be mistaken for a
      saved area by eye or by `queryRenderedFeatures` — `brush.spec.ts` asserts the
      latter mid-stroke and again with the sheet open.
- [~] Convert with `cellsToMultiPolygon`; reject a selection producing more than one outer ring, telling the user to paint a connected shape. No union, no repair.
      Done: `selectionToPolygon` returns `{ok: false, reason: "disconnected"}` for more
      than one group and `"empty"` for nothing painted. A hole inside a single outer ring
      is kept, not filled — verified against h3-js. The user-facing message is stage 2.
- [~] Brush size (1/2/3 rings via `gridDisk`) and erase toggle, both in the bottom third of the screen.
      `stampCells` maps sizes 1/2/3 to `gridDisk` k=0/1/2 (1/7/19 cells); erase is a
      stroke mode. Controls sit in the same bottom band as the draw controls, 44px tap
      targets, `aria-pressed` on the active size and on erase.
- [~] Undo removes the last stroke's cells, not the session.
      Done: `undoStroke` replays what the stroke actually changed, so undoing a paint
      stroke that re-touched existing cells leaves those alone, undoing an erase puts the
      erased cells back, and a stroke that changed nothing never consumes an undo.
- [~] Save path unchanged: the synthesised polygon goes to `saveArea` → `save-area`, which rederives cells from it.
      Release converts and opens the same `pendingFeature` → `RatingModal` → `saveArea`
      path a drawn polygon takes. `PendingFeature.drawId` is now nullable: a brushed
      polygon has nothing in Terra Draw's store. Saving resets the selection and stays
      in brush mode, ready for the next area. The offline queue path is unchanged and
      resets the same way.
- [~] Cap the session at `save-area`'s 5,000-cell ceiling, refusing further painting there rather than failing at save time.
      Done: `MAX_SELECTION_CELLS = 5000`, whole-stamp refusal (no ragged part-stamps),
      `refusedAtCap` flag for the UI, cleared when the next stroke opens.

---

## Decision: brush vs the saved-area click handler

While brush mode is active the pointer belongs to the brush and nothing else.

- A stroke that crosses a saved area paints over it. It does **not** also open an edit
  session on it: `handleAreaClick` returns early while brushing, which is what stops the
  `click` MapLibre fires after pointerup from arriving there.
- Brush mode cannot be entered while a draw or edit session is open — the "Paint area"
  button is hidden then, and `handleStartBrush` refuses as well.
- Exiting brush mode hands taps back to the saved-area handler.

The alternative (letting a tap on a saved area win over painting) was rejected: it makes
the outcome of a stroke depend on what happens to be underneath it, and there is no way
to paint across an already-rated area — which is the common case when refining a
neighbourhood.

## Decision: the map must not move while painting

`dragPan.disable()` on entering brush mode is not sufficient. Terra Draw's MapLibre
adapter restores map draggability behind our back — measured, `dragPan.isEnabled()` was
`false` immediately after entering brush mode and `true` again a few taps later, and the
map then panned with the finger so a stroke painted about a third of the ground it
covered. Brush pointer events therefore also stop propagating: MapLibre binds its drag
listeners to the canvas *container*, one level above the canvas the brush listens on, so
`stopPropagation` there means the map never sees a stroke at all. Two-finger pinch zoom
is on the container and is untouched, which is how you reposition without leaving the
mode.

---

## Stage 2 verification — watched runs

The full G8 `done_when` block from `docs/OBJECTIVES.md`, run in order:

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run test -- tests/unit/brush.test.ts` | exit 0, **35 passed** |
| `npm run test:e2e -- tests/e2e/brush.spec.ts` | exit 0, **3 passed** (390x844) |
| `! grep -rn 'from("area_cells")' src --include="*.ts" --include="*.tsx"` | exit 0 |

Regression runs, because `MapShell.tsx` is shared:

| Command | Result |
|---|---|
| `npm run test` (whole unit suite) | exit 0, **74 passed** across 7 files |
| `npm run test:e2e` (whole e2e suite) | exit 0, **18 passed**, twice consecutively |
| `npx tsc --noEmit -p tsconfig.app.json` | exit 0 |
| `npx oxlint src/map/MapShell.tsx src/map/brush.ts` | exit 0 |

E2E runs used `VITE_TILES_URL=/tiles/london-z14.pmtiles` and held the
`/tmp/areamap-e2e.lock` mutex (created by this session, released after the last run).

One cross-suite defect was found on the way and fixed in its own commit:
`draw-precision.spec.ts`'s `fetchGeometries` read every row in `areas` with the
service-role key, unscoped by user, so it counted this suite's saved area as its own
("Expected length: 1, Received length: 2"). Latent before — mvp-loop deletes its area
inside its test and touch-draw never saves. Both full e2e runs above are with the user
filter in place.

---

## Stage 1 verification — watched runs

| Command | Result |
|---|---|
| `npm run test -- tests/unit/brush.test.ts` | exit 0, **24 passed** |
| `npm run test -- tests/unit/brush.test.ts tests/unit/snapping.test.ts tests/unit/areas.test.ts tests/unit/queue.test.ts` | exit 0, **39 passed** (no regression from the dependency move) |
| `npx tsc --noEmit -p tsconfig.app.json` | exit 0 |
| `npx oxlint src/map/brush.ts tests/unit/brush.test.ts` | exit 0 |

Not run, deliberately: `tests/unit/schema.test.ts` and `tests/unit/save-area.test.ts`
need the local Supabase stack, which the G9 teammate is migrating; and the G8
`done_when`'s `npm run build` plus `tests/e2e/brush.spec.ts`, which belong to stage 2
(`brush.spec.ts` does not exist yet, and a build races the concurrent `vite.config.ts`
work). The `! grep -rn 'from("area_cells")' src` probe from the `done_when` does pass —
the core reads and renders cells but never writes them.

Test expectations were pinned against real h3-js output before they were written, not
assumed: `gridDisk` k=0/1/2 gives 1/7/19 cells; one cell converts to a single closed
7-coordinate ring in `[lng, lat]` order; two cells 6 km apart give two polygons; and six
cells around an unpainted centre give one polygon with two rings.
