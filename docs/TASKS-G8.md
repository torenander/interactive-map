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
- [ ] Brush mode: pointer-down opens a session, every `pointermove` adds `latLngToCell` at res 10, pointer-up closes it. Sample every move event rather than throttling to frames and dropping cells.
      Core done — `beginStroke` / `extendStroke` / `endStroke` in `src/map/brush.ts`, one
      stamp per call with no throttling, and `extendStroke` throws without an open stroke.
      **Stage 2:** the MapShell pointer handlers that call them.
- [ ] Render the live selection as its own source, distinct from saved-area fill.
      **Stage 2** (MapShell). `selectionCells` returns the cell ids to render.
- [~] Convert with `cellsToMultiPolygon`; reject a selection producing more than one outer ring, telling the user to paint a connected shape. No union, no repair.
      Done: `selectionToPolygon` returns `{ok: false, reason: "disconnected"}` for more
      than one group and `"empty"` for nothing painted. A hole inside a single outer ring
      is kept, not filled — verified against h3-js. The user-facing message is stage 2.
- [ ] Brush size (1/2/3 rings via `gridDisk`) and erase toggle, both in the bottom third of the screen.
      Core done — `stampCells` maps sizes 1/2/3 to `gridDisk` k=0/1/2 (1/7/19 cells) and
      erase is a stroke mode. **Stage 2:** the controls themselves.
- [~] Undo removes the last stroke's cells, not the session.
      Done: `undoStroke` replays what the stroke actually changed, so undoing a paint
      stroke that re-touched existing cells leaves those alone, undoing an erase puts the
      erased cells back, and a stroke that changed nothing never consumes an undo.
- [ ] Save path unchanged: the synthesised polygon goes to `saveArea` → `save-area`, which rederives cells from it.
      **Stage 2.** The core writes no cells and returns a plain GeoJSON `Polygon`, which
      is what `saveArea` already takes.
- [~] Cap the session at `save-area`'s 5,000-cell ceiling, refusing further painting there rather than failing at save time.
      Done: `MAX_SELECTION_CELLS = 5000`, whole-stamp refusal (no ragged part-stamps),
      `refusedAtCap` flag for the UI, cleared when the next stroke opens.

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
